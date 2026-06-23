const APP_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");

export function appPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!APP_BASE_PATH || normalized === APP_BASE_PATH || normalized.startsWith(`${APP_BASE_PATH}/`)) {
    return normalized;
  }
  return `${APP_BASE_PATH}${normalized}`;
}
