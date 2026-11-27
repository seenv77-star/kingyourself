export function consultationExpiry(now, value) {
  const expires = new Date(now);
  if (value === undefined || value === "") {
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  } else {
    if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 3650) {
      throw new Error("Invalid retention configuration");
    }
    expires.setUTCDate(expires.getUTCDate() + Number(value));
  }
  return expires.toISOString();
}
