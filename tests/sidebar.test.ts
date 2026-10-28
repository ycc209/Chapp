import { describe, expect, it } from 'vitest';
import { currentPage } from '../src/screens/home/Sidebar.tsx';

// The sidebar marks the page it was opened over (Sidebar.dc.html marks Chapp, opened over the home screen).
describe('the current page in the sidebar', () => {
  it('follows the route', () => {
    expect(currentPage('/', '')).toBe('/');
    expect(currentPage('/library', '')).toBe('/library');
    expect(currentPage('/library', '?view=shared')).toBe('/library?view=shared');
    expect(currentPage('/protocol', '?state=overview')).toBe('/protocol');
    expect(currentPage('/protocol/', '')).toBe('/protocol');
  });

  it('marks nothing over the other screens', () => {
    for (const path of ['/plan', '/run/3', '/results', '/share', '/import', '/kit']) expect(currentPage(path, ''), path).toBeNull();
  });
});
