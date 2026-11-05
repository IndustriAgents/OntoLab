/** Keep Neon's TLS hostname/certificate verification explicit across pg versions. */
export function postgresConnectionString(value: string): string {
  const url = new URL(value);
  if (url.hostname.endsWith(".neon.tech") && url.searchParams.get("sslmode") === "require") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.href;
}
