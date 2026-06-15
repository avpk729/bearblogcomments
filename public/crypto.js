/*
 * Shared browser crypto for end-to-end-encrypted comments (libsodium).
 *
 * Visitors SEAL {name, body} to the site owner's public key (anonymous sealed
 * box) — the server only ever stores ciphertext. The owner derives their
 * keypair in-browser from a passphrase (Argon2id -> seed -> X25519) and OPENS
 * the ciphertext to moderate. The private key never leaves the browser.
 *
 * Exposed as window.BBCrypto. Loads the pinned libsodium build from the service
 * origin (not a third-party CDN).
 */
(function () {
  'use strict';

  // Argon2id work factors. Stored per key server-side so they can change later
  // without breaking existing keypairs. Tuned to be feasible on mobile WASM.
  var DEFAULT_OPS = 3;
  var DEFAULT_MEM = 64 * 1024 * 1024; // 64 MiB

  var sodiumPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-bb="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-bb', src);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Load libsodium once (core then wrapper), resolve with the ready sodium API.
  function load(apiBase) {
    if (sodiumPromise) return sodiumPromise;
    var base = apiBase || '';
    sodiumPromise = loadScript(base + '/vendor/libsodium-sumo.js')
      .then(function () { return loadScript(base + '/vendor/libsodium-wrappers.js'); })
      .then(function () { return window.sodium.ready; })
      // Resolve with BBCrypto (the high-level helper), not the raw sodium API,
      // so callers can do BBCrypto.load().then(bb => bb.deriveKeypair(...)).
      .then(function () { return window.BBCrypto; });
    return sodiumPromise;
  }

  function b64() { return window.sodium.base64_variants.ORIGINAL; }

  function generateSalt() {
    var s = window.sodium;
    return s.to_base64(s.randombytes_buf(s.crypto_pwhash_SALTBYTES), b64());
  }

  // Derive an X25519 keypair deterministically from a passphrase + salt.
  // ops/mem are coerced to numbers — they may arrive as strings (Postgres
  // returns bigint columns as JS strings), and libsodium needs real numbers or
  // the derivation silently differs.
  function deriveKeypair(passphrase, saltB64, ops, mem) {
    var s = window.sodium;
    var seed = s.crypto_pwhash(
      s.crypto_box_SEEDBYTES,
      passphrase,
      s.from_base64(saltB64, b64()),
      Number(ops) || DEFAULT_OPS,
      Number(mem) || DEFAULT_MEM,
      s.crypto_pwhash_ALG_ARGON2ID13
    );
    var kp = s.crypto_box_seed_keypair(seed);
    return {
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyB64: s.to_base64(kp.publicKey, b64()),
      seedB64: s.to_base64(seed, b64()), // for the optional recovery code
    };
  }

  // Re-derive a keypair directly from a stored recovery seed (base64), for owners
  // who saved their recovery code but forgot the passphrase.
  function keypairFromSeed(seedB64) {
    var s = window.sodium;
    var kp = s.crypto_box_seed_keypair(s.from_base64(seedB64.trim(), b64()));
    return {
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyB64: s.to_base64(kp.publicKey, b64()),
    };
  }

  // Seal {name, body} to the owner's public key -> base64 ciphertext.
  function seal(publicKeyB64, payload) {
    var s = window.sodium;
    var msg = s.from_string(JSON.stringify(payload));
    var ct = s.crypto_box_seal(msg, s.from_base64(publicKeyB64, b64()));
    return s.to_base64(ct, b64());
  }

  // Open a sealed ciphertext with the owner's keypair -> parsed {name, body}.
  function open(ctB64, keypair) {
    var s = window.sodium;
    var opened = s.crypto_box_seal_open(
      s.from_base64(ctB64, b64()), keypair.publicKey, keypair.privateKey
    );
    return JSON.parse(s.to_string(opened));
  }

  window.BBCrypto = {
    DEFAULT_OPS: DEFAULT_OPS,
    DEFAULT_MEM: DEFAULT_MEM,
    load: load,
    generateSalt: generateSalt,
    deriveKeypair: deriveKeypair,
    keypairFromSeed: keypairFromSeed,
    seal: seal,
    open: open,
  };
})();
