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
const TRANSFER_AMOUNT = process.env.TRANSFER_AMOUNT  || '100000000000'; // default: 100,000 ZETRIX
const MIN_PLEDGE      = process.env.MIN_PLEDGE       || '100000000000'; // default: 100,000 ZETRIX
const REWARD_RATIO    = 0;
const TOTAL           = parseInt(process.env.TOTAL       || '337');
const START_INDEX     = parseInt(process.env.START_INDEX || '1');
const OUTPUT_FILE     = './output/validators.json';
const CONFIRM_RETRIES = 15;
const CONFIRM_DELAY   = 3000;

const sdk = new ZtxChainSDK({ host: HOST, secure: true });
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;

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

// ── Step 2: Transfer ZETRIX from funder to pool account ──────────────────────
// gasSendOperation transfers coins and auto-creates the account if it doesn't exist.
// Node account is NOT funded — keypair only, used when setting up the validator node.

async function activateAndFund(poolAddress) {
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

    const balanceResult = await sdk.account.getBalance(poolAddress);
    if (balanceResult.errorCode !== 0) throw new Error(`getBalance failed [${balanceResult.errorCode}]: ${JSON.stringify(balanceResult)}`);
    const balance = balanceResult.result.balance;
    console.log(`    Pool balance: ${balance} ZETA`);
    if (new BigNumber(balance).lt(MIN_PLEDGE)) {
        throw new Error(`Pool balance ${balance} ZETA is less than MIN_PLEDGE ${MIN_PLEDGE} ZETA — cannot apply`);
    }

    return hash;
}

// ── Step 3: Apply to DPoS contract ──────────────────────────────────────────
// Pool address is the sender and reward receiver.
// Node address is the P2P node identity — registered separately, not funded here.

async function applyAsValidator(poolAddress, poolPrivateKey, nodeAddress) {
    console.log(`  [3] Applying as validator (pool: ${poolAddress}, node: ${nodeAddress})...`);

    const input = {
        method: 'apply',
        params: {
            role:  'validator',
            pool:  poolAddress,   // reward pool address
            ratio: REWARD_RATIO,
            node:  nodeAddress,   // P2P node address (separate keypair)
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

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
    if (!FUNDER_ADDRESS || !FUNDER_KEY) {
        console.error('ERROR: FUNDER_ADDRESS and FUNDER_PRIVATE_KEY must be set in .env');
        process.exit(1);
    }

    const records = loadOutput();
    console.log(`Validator registration — total: ${TOTAL}, starting from index: ${START_INDEX}`);
    console.log(`Host: ${HOST}`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    for (let i = START_INDEX; i <= TOTAL; i++) {
        console.log(`\n── Validator ${i}/${TOTAL} ──────────────────────────────`);

        const record = {
            index:            i,
            pool:             { address: null, privateKey: null, publicKey: null },
            node:             { address: null, privateKey: null, publicKey: null },
            activationTxHash: null,
            applyTxHash:      null,
            status:           'pending',
            timestamp:        new Date().toISOString(),
        };

        try {
            // Step 1: Create pool account + node account
            console.log(`  [1] Creating pool and node accounts...`);
            const poolAccount = await createAccount();
            const nodeAccount = await createAccount();

            record.pool = poolAccount;
            record.node = nodeAccount;
            console.log(`    Pool: ${poolAccount.address}`);
            console.log(`    Node: ${nodeAccount.address}`);

            // Save keys immediately — never lose them even if next steps fail
            records.push(record);
            saveOutput(records);

            // Step 2: Activate + fund pool account only
            record.activationTxHash = await activateAndFund(poolAccount.address);

            // Step 3: Apply as validator — pool sends tx, node address registered
            record.applyTxHash = await applyAsValidator(
                poolAccount.address,
                poolAccount.privateKey,
                nodeAccount.address
            );

            record.status = 'applied';
            records[records.length - 1] = record;
            saveOutput(records);
            console.log(`  Done ✓`);

        } catch (err) {
            record.status = 'failed';
            record.error  = err.message;
            records[records.length - 1] = record;
            saveOutput(records);
            console.error(`  FAILED: ${err.message}`);
        }
    }

    const applied = records.filter(r => r.status === 'applied').length;
    const failed  = records.filter(r => r.status === 'failed').length;
    console.log(`\nCompleted. Applied: ${applied} | Failed: ${failed}`);
    console.log(`Results saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
