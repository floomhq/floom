export function isPublicWorkspaceProfilePath(pathname: string): boolean {
  return /^\/@[^/]+\/?$/.test(pathname);
}
