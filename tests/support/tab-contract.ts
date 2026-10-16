/**
 * The strip's pinned labels, in strip order — the tests' independent expectation.
 *
 * Nothing here may import from `src/`: these literals are the right-answer side of the
 * assertions that pin the strip's order and labels, so an import would compare the
 * product with itself and stop those assertions catching a wrong reorder or rename.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export const TAB_CONTRACT_LABELS = [
    'Status',
    'Dispatches',
    'Bindings',
    'Accounts',
    'Settings',
    'About',
    'Logs',
] as const;
