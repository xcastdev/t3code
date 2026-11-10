// Native initialization and catalogs use fetch; refuse before importing any native module.
globalThis.fetch = async () => {
  throw new Error("OMP proof forbids external network");
};
