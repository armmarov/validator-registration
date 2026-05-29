require('dotenv').config();
const ZtxChainSDK = require('zetrix-sdk-nodejs');
const BigNumber = require('bignumber.js');
const fs = require('fs');
const { PROPOSAL, getProposalState, getOnChainBalance } = require('./utils');

const HOST          = process.env.HOST          || 'node.zetrix.com';
const DPOS_CONTRACT = process.env.DPOS_CONTRACT || 'ZTX3ePNZQhndgGzKLmg1SFfno3N42mLhPYJMN';
const OUTPUT_FILE   = './output/validators.json';

const sdk = new ZtxChainSDK({ host: HOST, secure: true });

const PASS = '✓';
const FAIL = '✗';
const WARN = '!';

// Map on-chain proposal state to expected local status
const STATE_TO_STATUS = {
    [PROPOSAL.PENDING_APPROVAL]: 'applied',
    [PROPOSAL.APPROVED]:         'approved',
    [PROPOSAL.NOT_FOUND]:        'withdrawn',
};

function saveOutput(records) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2));
}

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

    const problems    = [];
    const statusFixed = [];
    const counts      = {};
    let passed = 0;
    let changed = false;

    for (const record of records) {
        const idx    = record.index;
        const pool   = record.pool || {};
        const node   = record.node || {};
        const status = record.status;
        const issues = [];
        let   icon   = PASS;

        counts[status] = (counts[status] || 0) + 1;

        // 1. Key completeness
        if (!pool.address)    issues.push('pool.address missing');
        if (!pool.privateKey) issues.push('pool.privateKey missing');
        if (!node.address)    issues.push('node.address missing');
        if (!node.privateKey) issues.push('node.privateKey missing');

        let balanceStr     = 'N/A';
        let proposalState  = 'N/A';
        let statusUpdated  = false;

        if (pool.address) {
            // 2. On-chain balance
            const balance = await getOnChainBalance(sdk, pool.address);
            if (balance === null) {
                issues.push('pool account not found on-chain');
                balanceStr = 'NOT FOUND';
            } else {
                balanceStr = `${balance} ZETA`;
                // Store balance in record for reference
                record.poolBalance = balance;
                changed = true;
            }

            // 3. getProposal — source of truth for registration status
            if (status !== 'pending' && status !== 'failed') {
                const onChainState = await getProposalState(sdk, DPOS_CONTRACT, pool.address);
                proposalState      = onChainState;

                if (onChainState === PROPOSAL.QUERY_ERROR) {
                    issues.push('getProposal query failed');
                } else {
                    const expectedStatus = STATE_TO_STATUS[onChainState];

                    if (expectedStatus && expectedStatus !== status) {
                        // On-chain state doesn't match local status — auto-update
                        const oldStatus   = status;
                        record.status     = expectedStatus;
                        counts[oldStatus] = (counts[oldStatus] || 1) - 1;
                        counts[expectedStatus] = (counts[expectedStatus] || 0) + 1;
                        statusUpdated = true;
                        statusFixed.push({ index: idx, from: oldStatus, to: expectedStatus });
                        changed = true;
                        icon = WARN;
                    }
                }
            } else {
                issues.push(`registration incomplete (status: ${status})`);
            }
        }

        const displayStatus = record.status.padEnd(10);
        const line          = `  ${icon} [${idx}] ${displayStatus} balance: ${balanceStr.padEnd(18)} proposal: ${proposalState}`;

        if (issues.length === 0 && !statusUpdated) {
            passed++;
            console.log(line);
        } else if (statusUpdated) {
            console.log(line + ` ← status auto-updated from '${statusFixed[statusFixed.length - 1].from}'`);
        } else {
            problems.push({ index: idx, pool: pool.address, node: node.address, issues });
            console.log(line);
            for (const issue of issues) {
                console.log(`       → ${issue}`);
            }
        }
    }

    // Save updated records (balance + any status fixes)
    if (changed) {
        saveOutput(records);
    }

    // Summary
    const countStr = Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(' | ');
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Result:    ${passed + statusFixed.length}/${records.length} ok`);
    console.log(`Breakdown: ${countStr}`);

    if (statusFixed.length > 0) {
        console.log(`\nAuto-fixed ${statusFixed.length} status mismatch(es):`);
        for (const fix of statusFixed) {
            console.log(`  [${fix.index}] '${fix.from}' → '${fix.to}'`);
        }
    }

    if (problems.length > 0) {
        console.log(`\nProblems (${problems.length}):`);
        for (const p of problems) {
            console.log(`  ${FAIL} [${p.index}] pool: ${p.pool || 'N/A'}`);
            for (const issue of p.issues) {
                console.log(`       → ${issue}`);
            }
        }
        console.log(`\nTip: Re-run register:validators / approve:validators / withdraw:validators to fix.`);
    } else if (statusFixed.length === 0) {
        console.log('\nAll records passed. No issues found.');
    }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
