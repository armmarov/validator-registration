// Shared utilities for all validator scripts

const BigNumber = require('bignumber.js');

// ── getProposal states ────────────────────────────────────────────────────────
const PROPOSAL = {
    NOT_FOUND:        'not_found',        // no proposal on-chain (withdrawn or never applied)
    PENDING_APPROVAL: 'pending_approval', // applied, awaiting committee vote
    APPROVED:         'approved',         // committee approved
    QUERY_ERROR:      'query_error',      // RPC failed
};

async function getProposalState(sdk, dposContract, poolAddress) {
    const info = await sdk.contract.call({
        optType:         2,
        contractAddress: dposContract,
        input:           JSON.stringify({
            method: 'getProposal',
            params: { operate: 'apply', item: 'validator', address: poolAddress },
        }),
    });

    if (info.errorCode !== 0) return PROPOSAL.QUERY_ERROR;

    try {
        const proposal = JSON.parse(info.result.query_rets[0].result.value).proposal;
        if (!proposal)                       return PROPOSAL.NOT_FOUND;
        if (proposal.passTime !== undefined) return PROPOSAL.APPROVED;
        return PROPOSAL.PENDING_APPROVAL;
    } catch (e) {
        return PROPOSAL.QUERY_ERROR;
    }
}

async function getOnChainBalance(sdk, address) {
    const result = await sdk.account.getBalance(address);
    if (result.errorCode !== 0) return null;
    return result.result.balance;
}

module.exports = { PROPOSAL, getProposalState, getOnChainBalance };
