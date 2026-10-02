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

export interface DriftNonceAccount {
  account: string;
  /** The council member named as nonce authority (the only key that can advance it). */
  authority: string;
  /** Who created it: an address that is not a council member, with six transactions in total. */
  createdBy: string;
  signature: string;
  slot: number;
  blockTime: number;
}

/**
 * The durable nonce accounts the two attack transactions used (public mainnet
 * data). Each was created and initialized in one transaction and never used
 * again until the attack, so the member's signature on the attack transaction
 * was made after its creation: the nonce value it carries did not exist before.
 */
export const DRIFT_NONCE_ACCOUNTS: DriftNonceAccount[] = [
  {
    account: "7s7s6saC5LHZoLyBXLM3pCjpWaA7meyQdP8NiH9ktAeC",
    authority: "39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8",
    createdBy: "FMJnBkVpHj5JzN7w4XFysCwY931CYSYk1DsXzqNi7YPF",
    signature: "LJuBqSWpfW6GSgWi2v64B6czZfd618ZXxPLBTQt2tSgF4hHCUgfYvUuAMxeSmfL4FnS8Wt9cKNaSK9YNke7kTz1",
    slot: 408444056,
    blockTime: 1774315326,
  },
  {
    account: "EmYEryTDXtuVCxrjNqJXbiwr4hfiJajd4g5P58vvhQnc",
    authority: "6UJbu9ut5VAsFYQFgPEa5xPfoyF5bB5oi4EknFPvu924",
    createdBy: "FMJnBkVpHj5JzN7w4XFysCwY931CYSYk1DsXzqNi7YPF",
    signature: "59yWWZjnLeu3WP6Dqj4NW21NWHhdNwkToCbypdNrAHKmhk5C37ZDUygbuDVPSN2XqYzME88k6Ss3sBKGdrmrWrX3",
    slot: 409999217,
    blockTime: 1774924549,
  },
];
