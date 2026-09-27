/**
 * The two Drift exploit transactions of 2026-04-01 (public mainnet data).
 * `unsignedBase64` is the exact message each Security Council member signed,
 * with signatures removed — what a pre-sign check would have been given.
 */

export interface DriftExploitTx {
  signature: string;
  slot: number;
  /** Unix seconds. */
  blockTime: number;
  /** The Security Council member who signed it. */
  signer: string;
  unsignedBase64: string;
}

export const DRIFT_MULTISIG = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";
export const DRIFT_PROGRAM = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
export const DRIFT_NEW_ADMIN = "H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL";

export const DRIFT_EXPLOIT_TXS: DriftExploitTx[] = [
  {
    signature: "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H",
    slot: 410344005,
    blockTime: 1775059518,
    signer: "39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8",
    unsignedBase64: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAMIH9hYErV4XikPqBdSr/B4HAoZn+DpP/Vw6mMapZAUpcsT2p4izt5hqfe4kl1EN90o6b7usccoiGr6aqfJsm6oGRTyMg4dsRyihUh47CbojtjK+VicBfxLmexQWw5HHRWDZfzsRo8uJGh5TA4AJvmFhb6ppRwyd17HyFrmkQfruNn8076t9/m/97Bb74GUNE6z/PJdKB9WR+buAYgPE8T4NQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABoHEzkfiI2i4sVVeyIevCS78fvu2bKP1L79o1Kyct6gGp9UXGSxWjuCKhF9z0peIzwNcMUWyGrNE2AYuqUAAAPoJrVNT30Q+LEw4ZvEYFP/ZAzLHmvzmgm1T448+BYUnBAUDAwcABAQAAAAGBQECAAAFowEw+k6o0OLa0wAAlAAAAAEBAQOQT8iVPc/J87UXmJPuEvycRFytiJqVfWHPuNvMFy9qT0o+70sDyCpxWZ6gehbuS89tzjE1fYRgsqwb1MOphgydCVTbvp7JYMmKeik/4hM2lm/hgNFRrkuBeVYfiYVKU/YBAgIAASgAobAo1Ty4s+TvXifglhVGqtRnSazAkuA8Gox8EYfoh8wkXbnPK8qamQAABgUBBAAABRHcPEngHmxPnwcAAAAAAAAAAAYDAQAECZAlpIi82Cr4AA=="
  },
  {
    signature: "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1",
    slot: 410344009,
    blockTime: 1775059519,
    signer: "6UJbu9ut5VAsFYQFgPEa5xPfoyF5bB5oi4EknFPvu924",
    unsignedBase64: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYLUUkEz7FfLaJjygMX5cDGGgvNfu9lTnGt5EUq42wAKo1KPu9LA8gqcVmeoHoW7kvPbc4xNX2EYLKsG9TDqYYMnZBPyJU9z8nztReYk+4S/JxEXK2ImpV9Yc+428wXL2pPzJDOxGOxYgUeKqXn+B9ykwj35IqmqnNj79y+Fl67ZQH8076t9/m/97Bb74GUNE6z/PJdKB9WR+buAYgPE8T4NQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE9qeIs7eYan3uJJdRDfdKOm+7rHHKIhq+mqnybJuqBkU8jIOHbEcooVIeOwm6I7YyvlYnAX8S5nsUFsORx0VgwlU276eyWDJinopP+ITNpZv4YDRUa5LgXlWH4mFSlP2BoHEzkfiI2i4sVVeyIevCS78fvu2bKP1L79o1Kyct6gGp9UXGSxWjuCKhF9z0peIzwNcMUWyGrNE2AYuqUAAAM4akCj91T+pyjf3uPgYecSepeQVNwg7z9tO/Usf8OuYAwUDAwoABAQAAAAJAwYABAmQJaSIvNgq+AAJBwYEBwACAQgIwgihV5mkGas="
  }
];
