require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const fs = require('fs');
const { PROPOSAL, getProposalState, getOnChainBalance } = require('./utils');
const BigNumber = require('bignumber.js');

const HOST          = process.env.HOST          || 'node.zetrix.com';
const DPOS_CONTRACT = process.env.DPOS_CONTRACT || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const MIN_PLEDGE    = process.env.MIN_PLEDGE    || '100000000000';
const OUTPUT_FILE   = './output/validators.json';

const sdk = new ZtxChainSDK({ host: HOST, secure: true });

const PASS = '✓';
const FAIL = '✗';

// Expected on-chain proposal state per local status
const EXPECTED_STATE = {
    'applied':   PROPOSAL.PENDING_APPROVAL,
    'approved':  PROPOSAL.APPROVED,
    'withdrawn': PROPOSAL.NOT_FOUND,
};

async function main() {
    if (!fs.existsSync(OUTPUT_FILE)) {
        console.error(`ERROR: ${OUTPUT_FILE} not found.`);
        process.exit(1);
    }

    const records = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    if (records.length === 0) {
        console.log('No records found.');
        return;
    }

    console.log(`Sanity check — ${records.length} record(s)`);
    console.log(`Host: ${HOST} | DPoS: ${DPOS_CONTRACT}\n`);

    const problems = [];
    const counts   = {};
    let passed = 0;

    for (const record of records) {
        const idx    = record.index;
        const pool   = record.pool  || {};
        const node   = record.node  || {};
        const status = record.status;
        const issues = [];

        counts[status] = (counts[status] || 0) + 1;

        // 1. Key completeness
        if (!pool.address)    issues.push('pool.address missing');
        if (!pool.privateKey) issues.push('pool.privateKey missing');
        if (!node.address)    issues.push('node.address missing');
        if (!node.privateKey) issues.push('node.privateKey missing');

        if (!pool.address) {
            problems.push({ index: idx, pool: null, node: null, issues });
            console.log(`  ${FAIL} [${idx}] ${(status || '?').padEnd(10)} pool: N/A`);
            continue;
        }

        if (status === 'pending' || status === 'failed') {
            // Not yet on-chain — just flag as incomplete
            issues.push(`registration incomplete (status: ${status})`);
        } else if (EXPECTED_STATE[status]) {
            // 2. Pool account exists on-chain
            const balance = await getOnChainBalance(sdk, pool.address);
            if (balance === null) {
                issues.push(`pool account not found on-chain`);
            }

            // 3. getProposal must match expected state for this status
            const onChainState = await getProposalState(sdk, DPOS_CONTRACT, pool.address);
            const expected     = EXPECTED_STATE[status];

            if (onChainState === PROPOSAL.QUERY_ERROR) {
                issues.push(`getProposal query failed — could not verify`);
            } else if (onChainState !== expected) {
                issues.push(`on-chain state mismatch: expected '${expected}' but got '${onChainState}' (local status: '${status}')`);
            }
        } else {
            issues.push(`unknown status '${status}'`);
        }

        if (issues.length === 0) {
            passed++;
            console.log(`  ${PASS} [${idx}] ${status.padEnd(10)} pool: ${pool.address}`);
        } else {
            problems.push({ index: idx, pool: pool.address, node: node.address, issues });
            console.log(`  ${FAIL} [${idx}] ${(status || '?').padEnd(10)} pool: ${pool.address}`);
        }
    }

    // Summary
    const countStr = Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(' | ');
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Result: ${passed}/${records.length} passed`);
    console.log(`Breakdown: ${countStr}`);

    if (problems.length > 0) {
        console.log(`\nProblems (${problems.length}):\n`);
        for (const p of problems) {
            console.log(`  ${FAIL} [${p.index}] pool: ${p.pool || 'N/A'} | node: ${p.node || 'N/A'}`);
            for (const issue of p.issues) {
                console.log(`       → ${issue}`);
            }
        }
        console.log(`\nTip: Re-run the appropriate script to fix — register:validators, approve:validators, or withdraw:validators.`);
    } else {
        console.log('\nAll records passed.');
    }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
