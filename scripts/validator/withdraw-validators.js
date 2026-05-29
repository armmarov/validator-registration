require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const BigNumber = require('bignumber.js');
const fs = require('fs');
const sleep = require('../../utils/delay');
const { PROPOSAL, getProposalState } = require('./utils');

const HOST          = process.env.HOST          || 'node.zetrix.com';
const DPOS_CONTRACT = process.env.DPOS_CONTRACT || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const OUTPUT_FILE   = './output/validators.json';
const CONFIRM_RETRIES = 15;
const CONFIRM_DELAY   = 3000;

const sdk = new ZtxChainSDK({ host: HOST, secure: true });

function loadOutput() {
    return fs.existsSync(OUTPUT_FILE) ? JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')) : [];
}
function saveOutput(records) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2));
}

async function waitForTx(hash) {
    for (let i = 0; i < CONFIRM_RETRIES; i++) {
        sleep(CONFIRM_DELAY);
        const info = await sdk.transaction.getInfo(hash);
        if (info.errorCode === 0) return info;
        console.log(`    Waiting for tx (${i + 1}/${CONFIRM_RETRIES})...`);
    }
    throw new Error(`Tx not confirmed: ${hash}`);
}

async function getNonce(address) {
    const r = await sdk.account.getNonce(address);
    if (r.errorCode !== 0) throw new Error(`getNonce failed [${r.errorCode}]`);
    return new BigNumber(r.result.nonce).plus(1).toString(10);
}

async function submitTx(sourceAddress, privateKey, operation) {
    const nonce   = await getNonce(sourceAddress);
    const feeData = await sdk.transaction.evaluateFee({ sourceAddress, nonce, operations: [operation], signtureNumber: '1' });
    if (feeData.errorCode !== 0) throw new Error(`evaluateFee failed [${feeData.errorCode}]: ${feeData.errorDesc}`);
    const blob = sdk.transaction.buildBlob({ sourceAddress, gasPrice: feeData.result.gasPrice, feeLimit: feeData.result.feeLimit, nonce, operations: [operation] });
    if (blob.errorCode !== 0) throw new Error(`buildBlob failed [${blob.errorCode}]`);
    const signed = sdk.transaction.sign({ privateKeys: [privateKey], blob: blob.result.transactionBlob });
    if (signed.errorCode !== 0) throw new Error(`sign failed [${signed.errorCode}]`);
    const submitted = await sdk.transaction.submit({ signature: signed.result.signatures, blob: blob.result.transactionBlob });
    if (submitted.errorCode !== 0) throw new Error(`submit failed [${submitted.errorCode}]: ${submitted.errorDesc}`);
    return submitted.result.hash;
}

async function main() {
    if (!fs.existsSync(OUTPUT_FILE)) {
        console.error(`ERROR: ${OUTPUT_FILE} not found.`);
        process.exit(1);
    }

    const records = loadOutput();
    // Process all records that have a pool address and are not approved
    const candidates = records.filter(r => r.pool && r.pool.address && r.status !== 'approved');

    console.log(`Withdraw validators — reclaim pledges from unapproved proposals`);
    console.log(`Host: ${HOST} | DPoS: ${DPOS_CONTRACT}`);
    console.log(`Records to check: ${candidates.length} of ${records.length}\n`);

    if (candidates.length === 0) {
        console.log('Nothing to check.');
        return;
    }

    let withdrawn = 0, skipped = 0, failed = 0;

    for (const record of candidates) {
        const pool = record.pool;
        const idx  = records.findIndex(r => r.index === record.index);
        console.log(`\n── Validator ${record.index} — pool: ${pool.address}`);

        // Always check getProposal — never rely on local withdrawTxHash
        console.log(`    Checking on-chain proposal state...`);
        const state = await getProposalState(sdk, DPOS_CONTRACT, pool.address);
        console.log(`    Proposal state: ${state}`);

        if (state === PROPOSAL.APPROVED) {
            // Already approved — update status, don't withdraw
            record.status = 'approved';
            records[idx]  = record;
            saveOutput(records);
            console.log(`    Proposal approved on-chain — status updated to approved, skipping withdraw`);
            skipped++;
            continue;
        }

        if (state === PROPOSAL.NOT_FOUND) {
            // Proposal gone — pledge already returned, just sync status
            record.status = 'withdrawn';
            records[idx]  = record;
            saveOutput(records);
            console.log(`    No proposal on-chain — pledge already returned, status updated to withdrawn`);
            withdrawn++;
            continue;
        }

        if (state === PROPOSAL.QUERY_ERROR) {
            console.log(`    Query error — skipping`);
            skipped++;
            continue;
        }

        // PENDING_APPROVAL — call withdraw to reclaim pledge
        try {
            const op = await sdk.operation.contractInvokeByGasOperation({
                contractAddress: DPOS_CONTRACT, sourceAddress: pool.address, gasAmount: '0',
                input: JSON.stringify({ method: 'withdraw', params: { role: 'validator' } }),
            });
            if (op.errorCode !== 0) throw new Error(`contractInvokeByGasOperation failed [${op.errorCode}]`);

            const hash = await submitTx(pool.address, pool.privateKey, op.result.operation);
            console.log(`    Withdraw tx: ${hash}`);
            await waitForTx(hash);

            // Verify on-chain after tx — proposal should be gone
            const stateAfter = await getProposalState(sdk, DPOS_CONTRACT, pool.address);
            record.withdrawTxHash = hash;
            record.status         = stateAfter === PROPOSAL.NOT_FOUND ? 'withdrawn' : record.status;
            records[idx]          = record;
            saveOutput(records);
            console.log(`    Verified state after withdraw: ${stateAfter}`);
            console.log(`  Done ✓ — pledge returned to ${pool.address}`);
            withdrawn++;
        } catch (err) {
            record.withdrawError = err.message;
            records[idx] = record;
            saveOutput(records);
            console.error(`  FAILED: ${err.message}`);
            failed++;
        }
    }

    console.log(`\nCompleted. Withdrawn: ${withdrawn} | Skipped: ${skipped} | Failed: ${failed}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
