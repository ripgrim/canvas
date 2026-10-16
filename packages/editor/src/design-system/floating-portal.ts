/** Keep floating controls inside the active mobile dialog so focus trapping and pointer input remain owned by it. */
export const floatingPortalContainer = (trigger: HTMLElement | null): HTMLElement | null => trigger?.closest<HTMLElement>('.mobile-sheet-popup') ?? trigger?.closest<HTMLElement>('[data-floating-portal-owner]') ?? trigger?.closest<HTMLElement>('.editor-root') ?? null
