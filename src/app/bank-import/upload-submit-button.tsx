'use client';

import { useFormStatus } from 'react-dom';

/**
 * The upload form's submit, disabled while the action runs. Extraction takes seconds (PDF
 * parse + model call) and gave no feedback; production logs showed the same file posted
 * several times in a row. Disabling during the pending state stops repeat submits and says
 * what is happening. The action itself stays the safety net (staging never posts).
 */
export function UploadSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      data-testid="upload-submit"
      className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
    >
      {pending ? 'Extracting…' : 'Upload & extract'}
    </button>
  );
}
