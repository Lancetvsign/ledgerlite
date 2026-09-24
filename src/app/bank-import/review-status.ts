import type { ReviewStatus } from '@/server/bank-import';

/** The review-status badge (LL-105), shared by the upload list and the review page. */
export const REVIEW_STATUS_TEXT: Readonly<Record<ReviewStatus, string>> = { new: 'New', in_progress: 'In progress', complete: 'Complete' };
export const REVIEW_STATUS_CLASS: Readonly<Record<ReviewStatus, string>> = {
  new: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
  in_progress: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  complete: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
};
