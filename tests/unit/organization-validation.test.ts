import { describe, expect, it } from 'vitest';

import { createOrganizationInput } from '@/validation/organization';

describe('createOrganizationInput', () => {
  it('trims and bounds the name', () => {
    expect(createOrganizationInput.parse({ name: '  Lehr Group  ' })).toEqual({ name: 'Lehr Group' });
    expect(createOrganizationInput.safeParse({ name: '   ' }).success).toBe(false);
    expect(createOrganizationInput.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(createOrganizationInput.safeParse({}).success).toBe(false);
  });
});
