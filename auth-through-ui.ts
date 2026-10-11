import { shell } from 'electron';
import { AuthFlow, getAuthURL } from './auth';
import type { PaperTabbedWindow } from '../window/paper-window';

/**
 * Initialize the auth flow handler.
 * @param getWindow - Function to get the window to navigate after auth
 */
export function initAuthThroughUIFlow(getWindow: () => PaperTabbedWindow): AuthFlow {
  /** Show a page in Electron while the user authenticates in their browser */
  function showWaitingForAuthPage(): void {
    getWindow().redirect({ route: '/www/desktop/sign-in.html' });
  }

  /** Start the PKCE auth flow: open browser and listen for callback */
  async function startAuthFlow(): Promise<void> {
    // Get the PKCE auth URL and open in system browser
    const authUrl = await getAuthURL();
    shell.openExternal(authUrl);
  }

  return {
    startAuthFlow,
    showWaitingForAuthPage,
  };
}
