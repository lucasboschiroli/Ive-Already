// Statuses are stored generically in the DB (planned/in_progress/completed/
// dropped/rewatched) so movies, TV, books, and games all share one schema.
// This maps them to the right verb per media type for display.

const STATUS_LABELS = {
    movie: {
        planned: 'Plan to Watch',
        in_progress: 'Watching',
        completed: 'Watched',
        dropped: 'Dropped',
        rewatched: 'Rewatched',
    },
    tv: {
        planned: 'Plan to Watch',
        in_progress: 'Watching',
        completed: 'Watched',
        dropped: 'Dropped',
        rewatched: 'Rewatched',
    },
    book: {
        planned: 'Plan to Read',
        in_progress: 'Reading',
        completed: 'Read',
        dropped: 'Dropped',
        rewatched: 'Reread',
    },
    game: {
        planned: 'Plan to Play',
        in_progress: 'Playing',
        completed: 'Played',
        dropped: 'Dropped',
        rewatched: 'Replayed',
    },
};

// Generic labels for cross-media contexts (catalog filter bar, sort dropdown)
// where a single status value spans multiple media types at once.
const GENERIC_STATUS_LABELS = {
    planned: 'Planned',
    in_progress: 'In Progress',
    completed: 'Completed',
    dropped: 'Dropped',
    rewatched: 'Rewatched',
};

function statusLabel(status, mediaType) {
    return STATUS_LABELS[mediaType]?.[status] || GENERIC_STATUS_LABELS[status] || status;
}

window.STATUS_LABELS = STATUS_LABELS;
window.GENERIC_STATUS_LABELS = GENERIC_STATUS_LABELS;
window.statusLabel = statusLabel;
