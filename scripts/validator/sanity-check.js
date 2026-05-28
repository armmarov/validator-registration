require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const fs = require('fs');

// ── Configuration ────────────────────────────────────────────────────────────
const HOST        = process.env.HOST || 'node.zetrix.com';
const OUTPUT_FILE = './output/validators.json';

const sdk = new ZtxChainSDK({ host: HOST, secure: true });

const PASS = '✓';
const FAIL = '✗';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function checkTx(hash, label) {
    if (!hash) return { ok: false, msg: `${label} tx hash missing` };

    const info = await sdk.transaction.getInfo(hash);
    if (info.errorCode !== 0) return { ok: false, msg: `${label} tx not found on-chain (${hash.substring(0, 12)}...)` };

    const tx = info.result.transactions[0];
    const errCode = parseInt(tx.error_code);
    if (errCode !== 0) return { ok: false, msg: `${label} tx failed on-chain with error_code ${errCode} (${hash.substring(0, 12)}...)` };

    return { ok: true };
}

async function checkPoolAccount(address) {
    if (!address) return { ok: false, msg: 'pool address missing' };

    const info = await sdk.account.getBalance(address);
    if (info.errorCode !== 0) return { ok: false, msg: `pool account not found on-chain (${info.errorCode})` };

    return { ok: true, balance: info.result.balance };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!fs.existsSync(OUTPUT_FILE)) {
        console.error(`ERROR: ${OUTPUT_FILE} not found. Run register:validators first.`);
        process.exit(1);
    }

    const records = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    if (records.length === 0) {
        console.log('No records found in validators.json.');
        return;
    }

    console.log(`Sanity check — ${records.length} record(s) in ${OUTPUT_FILE}`);
    console.log(`Host: ${HOST}\n`);

    const problems = [];
    let passed = 0;

    for (const record of records) {
        const idx  = record.index;
        const pool = record.pool || {};
        const node = record.node || {};
        const issues = [];

        // 1. Status
        if (record.status !== 'applied') {
            issues.push(`status is '${record.status}'`);
        }

        // 2. Field completeness
        if (!pool.address)    issues.push('pool.address missing');
        if (!pool.privateKey) issues.push('pool.privateKey missing');
        if (!node.address)    issues.push('node.address missing');
        if (!node.privateKey) issues.push('node.privateKey missing');

        if (pool.address) {
            // 3. Pool account exists on-chain
            const accountCheck = await checkPoolAccount(pool.address);
            if (!accountCheck.ok) {
                issues.push(accountCheck.msg);
            }

            // 4. Funding tx
            const fundingCheck = await checkTx(record.activationTxHash, 'funding');
            if (!fundingCheck.ok) issues.push(fundingCheck.msg);

            // 5. Apply tx
            const applyCheck = await checkTx(record.applyTxHash, 'apply');
            if (!applyCheck.ok) issues.push(applyCheck.msg);
        }

        if (issues.length === 0) {
            passed++;
            console.log(`  ${PASS} [${idx}] pool: ${pool.address}`);
        } else {
            problems.push({ index: idx, pool: pool.address, node: node.address, issues });
            console.log(`  ${FAIL} [${idx}] pool: ${pool.address || 'N/A'}`);
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Result: ${passed}/${records.length} passed`);

    if (problems.length > 0) {
        console.log(`\nProblems found (${problems.length}):\n`);
        for (const p of problems) {
            console.log(`  ${FAIL} [${p.index}] pool: ${p.pool || 'N/A'} | node: ${p.node || 'N/A'}`);
            for (const issue of p.issues) {
                console.log(`       → ${issue}`);
            }
        }
        console.log(`\nRe-run 'npm run register:validators' to fix failed records automatically.`);
    } else {
        console.log('\nAll records passed. No issues found.');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
