export function isRouterStatsPathname(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/router-stats";
}
