require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const BigNumber = require('bignumber.js');
const fs = require('fs');
const sleep = require('../../utils/delay');

// ── Configuration ────────────────────────────────────────────────────────────
const HOST            = process.env.HOST             || 'node.zetrix.com';
const FUNDER_ADDRESS  = process.env.FUNDER_ADDRESS;
const FUNDER_KEY      = process.env.FUNDER_PRIVATE_KEY;
const DPOS_CONTRACT   = process.env.DPOS_CONTRACT    || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const TRANSFER_AMOUNT = process.env.TRANSFER_AMOUNT  || '100000000000';
const MIN_PLEDGE      = process.env.MIN_PLEDGE       || '100000000000';
const REWARD_RATIO    = 0;
const TOTAL           = parseInt(process.env.TOTAL       || '337');
const OUTPUT_FILE     = './output/validators.json';
const CONFIRM_RETRIES = 15;
const CONFIRM_DELAY   = 3000;

const sdk = new ZtxChainSDK({ host: HOST, secure: true });

// ── Output helpers ───────────────────────────────────────────────────────────

function loadOutput() {
    if (fs.existsSync(OUTPUT_FILE)) {
        return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    }
    return [];
}

function saveOutput(records) {
    const dir = OUTPUT_FILE.substring(0, OUTPUT_FILE.lastIndexOf('/'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2));
}

// ── Transaction helpers ──────────────────────────────────────────────────────

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

// ── Account creation ─────────────────────────────────────────────────────────

async function createAccount() {
    const result = await sdk.account.create();
    if (result.errorCode !== 0) throw new Error(`account.create failed [${result.errorCode}]: ${JSON.stringify(result)}`);
    return {
        address:    result.result.address,
        privateKey: result.result.privateKey,
        publicKey:  result.result.publicKey,
    };
}

// ── Step 2: Fund pool account ─────────────────────────────────────────────────
// gasSendOperation transfers coins and auto-creates the account if needed.
// Returns the pool balance after funding.

async function fundPool(poolAddress) {
    console.log(`  [2] Funding pool account ${poolAddress} with ${TRANSFER_AMOUNT} ZETA...`);

    const operation = sdk.operation.gasSendOperation({
        sourceAddress: FUNDER_ADDRESS,
        destAddress:   poolAddress,
        gasAmount:     TRANSFER_AMOUNT,
    });
    if (operation.errorCode !== 0) throw new Error(`gasSendOperation failed [${operation.errorCode}]: ${JSON.stringify(operation)}`);

    const hash = await submitTx(FUNDER_ADDRESS, FUNDER_KEY, operation.result.operation);
    console.log(`    Funding tx: ${hash}`);
    await waitForTx(hash);

    return hash;
}

// ── Balance check ─────────────────────────────────────────────────────────────

async function checkBalance(poolAddress) {
    const balanceResult = await sdk.account.getBalance(poolAddress);
    if (balanceResult.errorCode !== 0) throw new Error(`getBalance failed [${balanceResult.errorCode}]: ${JSON.stringify(balanceResult)}`);
    const balance = balanceResult.result.balance;
    console.log(`    Pool balance: ${balance} ZETA`);
    if (new BigNumber(balance).lt(MIN_PLEDGE)) {
        throw new Error(`Pool balance ${balance} ZETA is less than MIN_PLEDGE ${MIN_PLEDGE} ZETA — cannot apply`);
    }
    return balance;
}

// ── Step 3: Apply to DPoS contract ───────────────────────────────────────────

async function applyAsValidator(poolAddress, poolPrivateKey, nodeAddress) {
    console.log(`  [3] Applying as validator (pool: ${poolAddress}, node: ${nodeAddress})...`);

    const input = {
        method: 'apply',
        params: {
            role:  'validator',
            pool:  poolAddress,
            ratio: REWARD_RATIO,
            node:  nodeAddress,
        },
    };

    const operation = await sdk.operation.contractInvokeByGasOperation({
        contractAddress: DPOS_CONTRACT,
        sourceAddress:   poolAddress,
        gasAmount:       MIN_PLEDGE,
        input:           JSON.stringify(input),
    });
    if (operation.errorCode !== 0) throw new Error(`contractInvokeByGasOperation failed [${operation.errorCode}]: ${JSON.stringify(operation)}`);

    const hash = await submitTx(poolAddress, poolPrivateKey, operation.result.operation);
    console.log(`    Apply tx: ${hash}`);
    await waitForTx(hash);
    return hash;
}

// ── Process one validator record ──────────────────────────────────────────────
// Resumes from whatever step was last completed, using on-chain balance as the
// source of truth for whether funding already happened.

async function processRecord(record, records, recordIndex) {
    try {
        delete record.error;

        // Step 2: Fund if not yet funded (check on-chain balance)
        if (!record.activationTxHash) {
            // Check if pool already has enough balance (e.g. funded manually or partial run)
            const balanceResult = await sdk.account.getBalance(record.pool.address);
            const alreadyFunded = balanceResult.errorCode === 0 &&
                new BigNumber(balanceResult.result.balance).gte(MIN_PLEDGE);

            if (alreadyFunded) {
                console.log(`  [2] Pool already funded (${balanceResult.result.balance} ZETA) — skipping transfer`);
            } else {
                record.activationTxHash = await fundPool(record.pool.address);
                records[recordIndex] = record;
                saveOutput(records);
            }
        } else {
            console.log(`  [2] Already funded (tx: ${record.activationTxHash}) — skipping`);
        }

        // Balance check before apply
        await checkBalance(record.pool.address);

        // Step 3: Apply if not yet applied
        if (!record.applyTxHash) {
            record.applyTxHash = await applyAsValidator(
                record.pool.address,
                record.pool.privateKey,
                record.node.address
            );
            records[recordIndex] = record;
            saveOutput(records);
        } else {
            console.log(`  [3] Already applied (tx: ${record.applyTxHash}) — skipping`);
        }

        record.status = 'applied';
        records[recordIndex] = record;
        saveOutput(records);
        console.log(`  Done ✓`);

    } catch (err) {
        record.status = 'failed';
        record.error  = err.message;
        records[recordIndex] = record;
        saveOutput(records);
        console.error(`  FAILED: ${err.message}`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!FUNDER_ADDRESS || !FUNDER_KEY) {
        console.error('ERROR: FUNDER_ADDRESS and FUNDER_PRIVATE_KEY must be set in .env');
        process.exit(1);
    }

    const records = loadOutput();
    console.log(`Validator registration — total: ${TOTAL}`);
    console.log(`Host: ${HOST}`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    // ── Phase 1: Resume any incomplete records from a previous run ────────────
    const incomplete = records
        .map((r, i) => ({ record: r, index: i }))
        .filter(({ record }) => record.status !== 'applied');

    if (incomplete.length > 0) {
        console.log(`Found ${incomplete.length} incomplete record(s) from previous run — resuming...\n`);
        for (const { record, index } of incomplete) {
            console.log(`\n── Resuming Validator ${record.index} (status: ${record.status}) ──────────────────`);
            await processRecord(record, records, index);
        }
    }

    // ── Phase 2: Create new validators up to TOTAL ────────────────────────────
    const applied = records.filter(r => r.status === 'applied').length;
    const remaining = TOTAL - applied;

    if (remaining <= 0) {
        console.log(`\nAll ${TOTAL} validators already applied. Nothing to do.`);
    } else {
        console.log(`\nCreating ${remaining} new validator(s)...\n`);
        for (let i = 1; i <= remaining; i++) {
            const globalIndex = records.length + 1;
            console.log(`\n── Validator ${globalIndex}/${TOTAL} ──────────────────────────────`);

            const record = {
                index:            globalIndex,
                pool:             { address: null, privateKey: null, publicKey: null },
                node:             { address: null, privateKey: null, publicKey: null },
                activationTxHash: null,
                applyTxHash:      null,
                status:           'pending',
                timestamp:        new Date().toISOString(),
            };

            // Step 1: Create accounts and save keys immediately
            console.log(`  [1] Creating pool and node accounts...`);
            try {
                const poolAccount = await createAccount();
                const nodeAccount = await createAccount();
                record.pool = poolAccount;
                record.node = nodeAccount;
                console.log(`    Pool: ${poolAccount.address}`);
                console.log(`    Node: ${nodeAccount.address}`);
            } catch (err) {
                record.status = 'failed';
                record.error  = err.message;
                records.push(record);
                saveOutput(records);
                console.error(`  FAILED: ${err.message}`);
                continue;
            }

            records.push(record);
            saveOutput(records);

            // Steps 2 & 3
            await processRecord(record, records, records.length - 1);
        }
    }

    const totalApplied = records.filter(r => r.status === 'applied').length;
    const totalFailed  = records.filter(r => r.status === 'failed').length;
    const totalPending = records.filter(r => r.status === 'pending').length;
    console.log(`\nCompleted. Applied: ${totalApplied} | Failed: ${totalFailed} | Pending: ${totalPending}`);
    console.log(`Results saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
