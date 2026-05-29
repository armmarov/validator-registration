require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const BigNumber = require('bignumber.js');
const fs = require('fs');
const sleep = require('../../utils/delay');

// ── Configuration ────────────────────────────────────────────────────────────
const HOST              = process.env.HOST               || 'node.zetrix.com';
const COMMITTEE_ADDRESS = process.env.COMMITTEE_ADDRESS;
const COMMITTEE_KEY     = process.env.COMMITTEE_PRIVATE_KEY;
const DPOS_CONTRACT     = process.env.DPOS_CONTRACT      || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const OUTPUT_FILE       = './output/validators.json';
const CONFIRM_RETRIES   = 15;
const CONFIRM_DELAY     = 3000;

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
        feeLimit:  feeData.result.feeLimit,
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

// ── Approve one validator application ────────────────────────────────────────

async function approveValidator(poolAddress) {
    const operation = await sdk.operation.contractInvokeByGasOperation({
        contractAddress: DPOS_CONTRACT,
        sourceAddress:   COMMITTEE_ADDRESS,
        gasAmount:       '0',
        input:           JSON.stringify({
            method: 'approve',
            params: {
                operate: 'apply',
                item:    'validator',
                address: poolAddress,
            },
        }),
    });
    if (operation.errorCode !== 0) throw new Error(`contractInvokeByGasOperation failed [${operation.errorCode}]: ${JSON.stringify(operation)}`);

    const hash = await submitTx(COMMITTEE_ADDRESS, COMMITTEE_KEY, operation.result.operation);
    console.log(`    Approve tx: ${hash}`);
    await waitForTx(hash);
    return hash;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!COMMITTEE_ADDRESS || !COMMITTEE_KEY) {
        console.error('ERROR: COMMITTEE_ADDRESS and COMMITTEE_PRIVATE_KEY must be set in .env');
        process.exit(1);
    }

    if (!fs.existsSync(OUTPUT_FILE)) {
        console.error(`ERROR: ${OUTPUT_FILE} not found. Run register:validators first.`);
        process.exit(1);
    }

    const records = loadOutput();
    const pending = records.filter(r => r.status === 'applied' && !r.approveTxHash);

    console.log(`Approve validators — committee: ${COMMITTEE_ADDRESS}`);
    console.log(`Host: ${HOST}`);
    console.log(`DPoS contract: ${DPOS_CONTRACT}`);
    console.log(`Records to approve: ${pending.length} of ${records.length}\n`);

    if (pending.length === 0) {
        console.log('Nothing to approve. All applied records already have an approval tx.');
        return;
    }

    let approved = 0;
    let failed   = 0;

    for (const record of pending) {
        const poolAddress = record.pool && record.pool.address;
        console.log(`\n── Approving Validator ${record.index} — pool: ${poolAddress}`);

        try {
            record.approveTxHash = await approveValidator(poolAddress);
            record.status        = 'approved';
            approved++;
            console.log(`  Done ✓`);
        } catch (err) {
            record.approveError = err.message;
            failed++;
            console.error(`  FAILED: ${err.message}`);
        }

        // Save after every record so progress is never lost
        const idx = records.findIndex(r => r.index === record.index);
        records[idx] = record;
        saveOutput(records);
    }

    console.log(`\nCompleted. Approved: ${approved} | Failed: ${failed}`);
    console.log(`Results saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
