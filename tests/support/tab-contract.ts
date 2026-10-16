/**
 * The strip's pinned ids and labels, in strip order — the tests' independent expectation.
 *
 * Nothing here may import from `src/`: these literals are the right-answer side of the
 * assertions that pin the strip's order and labels, so an import would compare the
 * product with itself and stop those assertions catching a wrong reorder or rename.
 */
export const TAB_CONTRACT_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about', 'logs'] as const;

export const TAB_CONTRACT_LABELS = [
    'Status',
    'Dispatches',
    'Bindings',
    'Accounts',
    'Settings',
    'About',
    'Logs',
] as const;
