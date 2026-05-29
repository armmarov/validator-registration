require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const BigNumber = require('bignumber.js');
const fs = require('fs');
const sleep = require('../../utils/delay');

// ── Configuration ────────────────────────────────────────────────────────────
const HOST          = process.env.HOST          || 'node.zetrix.com';
const DPOS_CONTRACT = process.env.DPOS_CONTRACT || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const OUTPUT_FILE   = './output/validators.json';
const CONFIRM_RETRIES = 15;
const CONFIRM_DELAY   = 3000;

const sdk = new ZtxChainSDK({ host: HOST, secure: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadOutput() {
    if (fs.existsSync(OUTPUT_FILE)) {
        return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    }
    return [];
}

function saveOutput(records) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2));
}

async function waitForTx(hash) {
    for (let i = 0; i < CONFIRM_RETRIES; i++) {
        sleep(CONFIRM_DELAY);
        const info = await sdk.transaction.getInfo(hash);
        if (info.errorCode === 0) return info;
        console.log(`    Waiting for tx confirmation (${i + 1}/${CONFIRM_RETRIES})...`);
    }
    throw new Error(`Tx not confirmed after ${CONFIRM_RETRIES} retries: ${hash}`);
}

async function getNonce(address) {
    const result = await sdk.account.getNonce(address);
    if (result.errorCode !== 0) throw new Error(`getNonce failed [${result.errorCode}]: ${JSON.stringify(result)}`);
    return new BigNumber(result.result.nonce).plus(1).toString(10);
}

async function submitTx(sourceAddress, privateKey, operation) {
    const nonce = await getNonce(sourceAddress);

    const feeData = await sdk.transaction.evaluateFee({
        sourceAddress,
        nonce,
        operations: [operation],
        signtureNumber: '1',
    });
    if (feeData.errorCode !== 0) throw new Error(`evaluateFee failed [${feeData.errorCode}]: ${JSON.stringify(feeData)}`);

    const blob = sdk.transaction.buildBlob({
        sourceAddress,
        gasPrice: feeData.result.gasPrice,
        feeLimit: feeData.result.feeLimit,
        nonce,
        operations: [operation],
    });
    if (blob.errorCode !== 0) throw new Error(`buildBlob failed [${blob.errorCode}]: ${JSON.stringify(blob)}`);

    const signed = sdk.transaction.sign({
        privateKeys: [privateKey],
        blob: blob.result.transactionBlob,
    });
    if (signed.errorCode !== 0) throw new Error(`sign failed [${signed.errorCode}]: ${JSON.stringify(signed)}`);

    const submitted = await sdk.transaction.submit({
        signature: signed.result.signatures,
        blob: blob.result.transactionBlob,
    });
    if (submitted.errorCode !== 0) throw new Error(`submit failed [${submitted.errorCode}]: ${JSON.stringify(submitted)}`);

    return submitted.result.hash;
}

// ── Pre-check: query proposal state from DPoS contract ───────────────────────
// Returns one of:
//   { canWithdraw: true,  reason: '...' }
//   { canWithdraw: false, reason: '...' }

async function checkProposal(poolAddress) {
    const info = await sdk.contract.call({
        optType:         2,
        contractAddress: DPOS_CONTRACT,
        input:           JSON.stringify({
            method: 'getProposal',
            params: {
                operate: 'apply',
                item:    'validator',
                address: poolAddress,
            },
        }),
    });

    if (info.errorCode !== 0) {
        return { canWithdraw: false, reason: `DPoS query failed (${info.errorCode})` };
    }

    let proposal;
    try {
        const parsed = JSON.parse(info.result.query_rets[0].result.value);
        proposal = parsed.proposal;
    } catch (e) {
        return { canWithdraw: false, reason: 'Failed to parse proposal response' };
    }

    // Proposal doesn't exist — already withdrawn or never applied
    if (!proposal) {
        return { canWithdraw: false, alreadyGone: true, reason: 'No proposal found on-chain (already withdrawn or never applied)' };
    }

    // Already approved — use withdraw only after cooldown period, not handled here
    if (proposal.passTime !== undefined) {
        return { canWithdraw: false, reason: 'Proposal was already approved — use withdraw after cooldown period' };
    }

    // Not yet approved (passTime undefined) — can withdraw anytime to reclaim pledge
    return {
        canWithdraw: true,
        reason:      `Proposal not approved (pledge: ${proposal.pledge} ZETA)`,
        pledge:      proposal.pledge,
    };
}

// ── Withdraw one validator's pledge ──────────────────────────────────────────

async function withdrawValidator(poolAddress, poolPrivateKey) {
    const operation = await sdk.operation.contractInvokeByGasOperation({
        contractAddress: DPOS_CONTRACT,
        sourceAddress:   poolAddress,
        gasAmount:       '0',
        input:           JSON.stringify({
            method: 'withdraw',
            params: { role: 'validator' },
        }),
    });
    if (operation.errorCode !== 0) throw new Error(`contractInvokeByGasOperation failed [${operation.errorCode}]: ${JSON.stringify(operation)}`);

    const hash = await submitTx(poolAddress, poolPrivateKey, operation.result.operation);
    console.log(`    Withdraw tx: ${hash}`);
    await waitForTx(hash);
    return hash;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!fs.existsSync(OUTPUT_FILE)) {
        console.error(`ERROR: ${OUTPUT_FILE} not found.`);
        process.exit(1);
    }

    const records = loadOutput();

    // Include all records that are not yet in a final withdrawn/approved state.
    // This catches:
    //   - status='applied', no withdrawTxHash          → needs withdraw
    //   - status='applied', withdrawTxHash set          → tx was submitted but status
    //                                                     not updated (crashed mid-run)
    //   - status='failed'  with applyTxHash             → may be withdrawable
    const candidates = records.filter(r =>
        r.applyTxHash &&
        r.status !== 'approved' &&
        r.status !== 'withdrawn'
    );

    console.log(`Withdraw validators — reclaim pledges from unapproved proposals`);
    console.log(`Host: ${HOST}`);
    console.log(`DPoS contract: ${DPOS_CONTRACT}`);
    console.log(`Candidates to check: ${candidates.length} of ${records.length}\n`);

    if (candidates.length === 0) {
        console.log('Nothing to withdraw.');
        return;
    }

    let succeeded = 0;
    let skipped   = 0;
    let failed    = 0;

    for (const record of candidates) {
        const pool = record.pool || {};
        const idx  = records.findIndex(r => r.index === record.index);
        console.log(`\n── Validator ${record.index} — pool: ${pool.address}`);

        // ── Case 1: withdrawTxHash already set — tx submitted in a previous run
        //    but status was never updated. Verify the tx on-chain and sync status.
        if (record.withdrawTxHash) {
            console.log(`    Withdraw tx already recorded: ${record.withdrawTxHash.substring(0, 16)}...`);
            console.log(`    Verifying tx on-chain...`);
            const txInfo = await sdk.transaction.getInfo(record.withdrawTxHash);
            if (txInfo.errorCode === 0 && parseInt(txInfo.result.transactions[0].error_code) === 0) {
                record.status = 'withdrawn';
                records[idx]  = record;
                saveOutput(records);
                console.log(`    Status updated to 'withdrawn' — tx confirmed on-chain.`);
                succeeded++;
            } else {
                // Tx not found or failed — clear the hash and fall through to retry
                console.log(`    Tx not confirmed (${txInfo.errorCode}) — clearing hash and retrying...`);
                record.withdrawTxHash = null;
                records[idx] = record;
                saveOutput(records);
            }
            if (record.status === 'withdrawn') continue;
        }

        // ── Case 2: No withdrawTxHash — check proposal state on-chain first
        console.log(`    Checking proposal state on-chain...`);
        const check = await checkProposal(pool.address);
        console.log(`    ${check.reason}`);

        if (!check.canWithdraw) {
            // Proposal is gone from chain but status not updated — pledge was
            // already returned in a previous run that crashed before file write.
            if (check.alreadyGone) {
                record.status = 'withdrawn';
                records[idx]  = record;
                saveOutput(records);
                console.log(`    Status updated to 'withdrawn' — proposal already gone from chain.`);
                succeeded++;
            } else {
                console.log(`    Skipping.`);
                skipped++;
            }
            continue;
        }

        // ── Case 3: Proposal exists and is withdrawable — submit withdraw tx
        try {
            record.withdrawTxHash = await withdrawValidator(pool.address, pool.privateKey);
            record.status         = 'withdrawn';
            succeeded++;
            console.log(`  Done ✓ — pledge returned to ${pool.address}`);
        } catch (err) {
            record.withdrawError = err.message;
            failed++;
            console.error(`  FAILED: ${err.message}`);
        }

        records[idx] = record;
        saveOutput(records);
    }

    console.log(`\nCompleted. Withdrawn: ${succeeded} | Skipped: ${skipped} | Failed: ${failed}`);
    console.log(`Results saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
