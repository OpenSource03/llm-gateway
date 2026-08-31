export const secureDataPlaneHeaders = (headers = new Headers()): Headers => {
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Authorization");

  return headers;
};
