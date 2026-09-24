'use client';

import { useState } from 'react';

/**
 * The "take" tick for one untaken row (LL-097). Always submits a value ('1' or '0') so the
 * action can zip the per-row arrays by index whatever is ticked.
 */
export function TakeCheckbox({ index, initialChecked = false }: { index: number; /** LL-105: the saved draft's tick. */ initialChecked?: boolean }) {
  const [checked, setChecked] = useState(initialChecked);
  return (
    <>
      <input type="hidden" name="take" value={checked ? '1' : '0'} />
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
        }}
        aria-label="Take this line"
        data-testid={`shared-take-${String(index)}`}
      />
    </>
  );
}
