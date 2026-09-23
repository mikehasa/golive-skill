export interface InstallationInfo {
  manager: 'owned' | 'external' | null;
  location: string;
  pin?: string | null;
  autoUpdate?: boolean;
  version?: string;
  ref?: string | null;
  source?: string;
  updateCommand?: string;
}
export function statusForBundle(bundleRoot: string): InstallationInfo;
