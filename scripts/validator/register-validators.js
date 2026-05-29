require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const BigNumber = require('bignumber.js');
const fs = require('fs');
const sleep = require('../../utils/delay');
const { PROPOSAL, getProposalState, getOnChainBalance } = require('./utils');

const HOST            = process.env.HOST             || 'node.zetrix.com';
const FUNDER_ADDRESS  = process.env.FUNDER_ADDRESS;
const FUNDER_KEY      = process.env.FUNDER_PRIVATE_KEY;
const DPOS_CONTRACT   = process.env.DPOS_CONTRACT    || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const TRANSFER_AMOUNT = process.env.TRANSFER_AMOUNT  || '100000000000';
const MIN_PLEDGE      = process.env.MIN_PLEDGE       || '100000000000';
const REWARD_RATIO    = 0;
const TOTAL           = parseInt(process.env.TOTAL   || '337');
const OUTPUT_FILE     = './output/validators.json';
const CONFIRM_RETRIES = 15;
const CONFIRM_DELAY   = 3000;

const sdk = new ZtxChainSDK({ host: HOST, secure: true });

function loadOutput() {
    return fs.existsSync(OUTPUT_FILE) ? JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')) : [];
}
function saveOutput(records) {
    const dir = OUTPUT_FILE.substring(0, OUTPUT_FILE.lastIndexOf('/'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

async function createAccount() {
    const r = await sdk.account.create();
    if (r.errorCode !== 0) throw new Error(`account.create failed [${r.errorCode}]`);
    return { address: r.result.address, privateKey: r.result.privateKey, publicKey: r.result.publicKey };
}

async function fundPool(poolAddress) {
    console.log(`  [2] Funding pool ${poolAddress} with ${TRANSFER_AMOUNT} ZETA...`);
    const op = sdk.operation.gasSendOperation({ sourceAddress: FUNDER_ADDRESS, destAddress: poolAddress, gasAmount: TRANSFER_AMOUNT });
    if (op.errorCode !== 0) throw new Error(`gasSendOperation failed [${op.errorCode}]`);
    const hash = await submitTx(FUNDER_ADDRESS, FUNDER_KEY, op.result.operation);
    console.log(`    Funding tx: ${hash}`);
    await waitForTx(hash);
    return hash;
}

async function applyAsValidator(poolAddress, poolPrivateKey, nodeAddress) {
    console.log(`  [3] Applying (pool: ${poolAddress}, node: ${nodeAddress})...`);
    const op = await sdk.operation.contractInvokeByGasOperation({
        contractAddress: DPOS_CONTRACT, sourceAddress: poolAddress, gasAmount: MIN_PLEDGE,
        input: JSON.stringify({ method: 'apply', params: { role: 'validator', pool: poolAddress, ratio: REWARD_RATIO, node: nodeAddress } }),
    });
    if (op.errorCode !== 0) throw new Error(`contractInvokeByGasOperation failed [${op.errorCode}]`);
    const hash = await submitTx(poolAddress, poolPrivateKey, op.result.operation);
    console.log(`    Apply tx: ${hash}`);
    await waitForTx(hash);
    return hash;
}

// ── Process one record — all decisions from on-chain state ────────────────────

async function processRecord(record, records, recordIndex) {
    try {
        delete record.error;

        // Step 2: Fund only if on-chain balance < MIN_PLEDGE
        const balance  = await getOnChainBalance(sdk, record.pool.address);
        const hasFunds = balance !== null && new BigNumber(balance).gte(MIN_PLEDGE);

        if (hasFunds) {
            console.log(`  [2] Pool balance sufficient (${balance} ZETA) — skipping fund`);
        } else {
            record.activationTxHash = await fundPool(record.pool.address);
            records[recordIndex] = record;
            saveOutput(records);

            const newBalance = await getOnChainBalance(sdk, record.pool.address);
            console.log(`    Pool balance: ${newBalance} ZETA`);
            if (!newBalance || new BigNumber(newBalance).lt(MIN_PLEDGE)) {
                throw new Error(`Pool balance ${newBalance} ZETA still below MIN_PLEDGE ${MIN_PLEDGE} after funding`);
            }
        }

        // Step 3: Check getProposal on-chain — never rely on local applyTxHash
        console.log(`  [3] Checking on-chain registration...`);
        const state = await getProposalState(sdk, DPOS_CONTRACT, record.pool.address);
        console.log(`    Proposal state: ${state}`);

        if (state === PROPOSAL.APPROVED) {
            console.log(`    Already approved — updating status`);
            record.status = 'approved';

        } else if (state === PROPOSAL.PENDING_APPROVAL) {
            console.log(`    Already registered, awaiting approval — skipping apply`);
            record.status = 'applied';

        } else {
            // not_found or query_error → apply (fresh or re-apply after withdrawal)
            record.applyTxHash    = null;
            record.withdrawTxHash = null;
            record.applyTxHash    = await applyAsValidator(record.pool.address, record.pool.privateKey, record.node.address);
            record.status         = 'applied';
        }

        records[recordIndex] = record;
        saveOutput(records);
        console.log(`  Done ✓ (status: ${record.status})`);

    } catch (err) {
        record.status = 'failed';
        record.error  = err.message;
        records[recordIndex] = record;
        saveOutput(records);
        console.error(`  FAILED: ${err.message}`);
    }
}

async function main() {
    if (!FUNDER_ADDRESS || !FUNDER_KEY) {
        console.error('ERROR: FUNDER_ADDRESS and FUNDER_PRIVATE_KEY must be set in .env');
        process.exit(1);
    }

    const records = loadOutput();
    console.log(`Validator registration — total: ${TOTAL}`);
    console.log(`Host: ${HOST}\n`);

    // Phase 1: resume pending / failed / withdrawn (anything not yet applied/approved)
    const incomplete = records
        .map((r, i) => ({ record: r, index: i }))
        .filter(({ record }) => record.status !== 'applied' && record.status !== 'approved');

    if (incomplete.length > 0) {
        console.log(`Found ${incomplete.length} incomplete record(s) — resuming...\n`);
        for (const { record, index } of incomplete) {
            console.log(`\n── Resuming Validator ${record.index} (status: ${record.status}) ──────────────────`);
            await processRecord(record, records, index);
        }
    }

    // Phase 2: create new validators until TOTAL reached
    const registered = records.filter(r => r.status === 'applied' || r.status === 'approved').length;
    const remaining  = TOTAL - registered;

    if (remaining <= 0) {
        console.log(`\nAll ${TOTAL} validators registered. Nothing to do.`);
    } else {
        console.log(`\nCreating ${remaining} new validator(s)...\n`);
        for (let i = 1; i <= remaining; i++) {
            const globalIndex = records.length + 1;
            console.log(`\n── Validator ${globalIndex}/${TOTAL} ──────────────────────────────`);

            const record = {
                index: globalIndex,
                pool: { address: null, privateKey: null, publicKey: null },
                node: { address: null, privateKey: null, publicKey: null },
                activationTxHash: null, applyTxHash: null, status: 'pending',
                timestamp: new Date().toISOString(),
            };

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
            await processRecord(record, records, records.length - 1);
        }
    }

    const counts = ['applied', 'approved', 'withdrawn', 'failed', 'pending']
        .map(s => `${s.charAt(0).toUpperCase() + s.slice(1)}: ${records.filter(r => r.status === s).length}`)
        .join(' | ');
    console.log(`\nCompleted. ${counts}`);
    console.log(`Results saved to ${OUTPUT_FILE}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
