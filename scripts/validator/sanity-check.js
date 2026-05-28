require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const fs = require('fs');

// ── Configuration ────────────────────────────────────────────────────────────
const HOST          = process.env.HOST          || 'node.zetrix.com';
const DPOS_CONTRACT = process.env.DPOS_CONTRACT || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const OUTPUT_FILE   = './output/validators.json';

const sdk = new ZtxChainSDK({ host: HOST, secure: true });
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

const PASS = '✓';
const FAIL = '✗';

function result(ok, msg) {
    return { ok, msg };
}

async function checkTx(hash) {
    if (!hash) return result(false, 'missing');
    const info = await sdk.transaction.getInfo(hash);
    if (info.errorCode !== 0) return result(false, `tx not found (${info.errorCode})`);
    const tx = info.result.transactions[0];
    if (tx.error_code !== '0' && tx.error_code !== 0) return result(false, `tx failed on-chain (error_code: ${tx.error_code})`);
    return result(true, hash.substring(0, 12) + '...');
}

async function checkAccount(address) {
    if (!address) return result(false, 'missing');
    const info = await sdk.account.getBalance(address);
    if (info.errorCode !== 0) return result(false, `account not found (${info.errorCode})`);
    return result(true, `balance: ${info.result.balance} ZETA`);
}

// ── Fetch DPoS candidate list once ───────────────────────────────────────────

async function getDPoSCandidates() {
    const info = await sdk.contract.callContract({
        contractAddress: DPOS_CONTRACT,
        input:           JSON.stringify({ method: 'getValidatorCandidates' }),
    });
    if (info.errorCode !== 0) return null;
    try {
        const parsed = JSON.parse(info.result.query_rets[0].result.value);
        return parsed.validator_candidates || [];
    } catch (e) {
        return null;
    }
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
    console.log(`Host: ${HOST}`);
    console.log(`DPoS contract: ${DPOS_CONTRACT}\n`);

    // Fetch DPoS candidate list once for all records
    process.stdout.write('Fetching DPoS candidate list... ');
    const candidates = await getDPoSCandidates();
    if (candidates === null) {
        console.log('FAILED — DPoS query error, skipping DPoS registration check');
    } else {
        console.log(`${candidates.length} candidate(s) found`);
    }
    console.log('');

    // Build a set of registered pool addresses and node addresses for quick lookup
    const registeredPools = new Set(candidates ? candidates.map(c => c[0]) : []);
    const registeredNodes = new Set(candidates ? candidates.map(c => c[2]) : []);

    const problems = [];
    let passed = 0;

    for (const record of records) {
        const idx    = record.index;
        const pool   = record.pool   || {};
        const node   = record.node   || {};
        const issues = [];

        // 1. Status check
        if (record.status !== 'applied') {
            issues.push(`status is '${record.status}'`);
        }

        // 2. Field completeness
        if (!pool.address)    issues.push('pool.address missing');
        if (!pool.privateKey) issues.push('pool.privateKey missing');
        if (!node.address)    issues.push('node.address missing');
        if (!node.privateKey) issues.push('node.privateKey missing');

        // Skip on-chain checks if addresses are missing
        if (pool.address) {
            // 3. Pool account on-chain
            const accountCheck = await checkAccount(pool.address);
            if (!accountCheck.ok) issues.push(`pool account: ${accountCheck.msg}`);

            // 4. Activation (funding) tx
            const fundingCheck = await checkTx(record.activationTxHash);
            if (!fundingCheck.ok) issues.push(`funding tx: ${fundingCheck.msg}`);

            // 5. Apply tx
            const applyCheck = await checkTx(record.applyTxHash);
            if (!applyCheck.ok) issues.push(`apply tx: ${applyCheck.msg}`);

            // 6. DPoS registration
            if (candidates !== null) {
                if (!registeredPools.has(pool.address)) {
                    issues.push(`pool not found in DPoS candidates`);
                }
                if (node.address && !registeredNodes.has(node.address)) {
                    issues.push(`node not found in DPoS candidates`);
                }
            }
        }

        const ok = issues.length === 0;
        if (ok) {
            passed++;
            console.log(`  ${PASS} [${idx}] pool: ${pool.address}`);
        } else {
            problems.push({ index: idx, pool: pool.address, node: node.address, issues });
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
    } else {
        console.log('\nAll records passed. No issues found.');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
