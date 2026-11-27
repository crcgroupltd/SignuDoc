import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildEmailAddresses,
  extractEmailAddress,
  getAddressDomain,
} from "./email-addresses.ts";

const FALLBACK = "no-reply@sign.acme.com";

const base = {
  hosted: false,
  organizationName: "Acme Corp",
  senderAddress: null,
  supportAddress: null,
};

test("with no sender set, mail goes out from the fallback address under the organization's name", () => {
  assert.deepEqual(buildEmailAddresses(base, FALLBACK), {
    senderAddress: "Acme Corp <no-reply@sign.acme.com>",
    supportAddress: null,
  });
});

test("the organization's own address gets its name in front", () => {
  assert.deepEqual(
    buildEmailAddresses(
      {
        ...base,
        senderAddress: " sign@acme.com ",
        supportAddress: " help@acme.com ",
      },
      FALLBACK,
    ),
    {
      senderAddress: "Acme Corp <sign@acme.com>",
      supportAddress: "help@acme.com",
    },
  );
});

test("a sender that already carries a display name is left alone", () => {
  assert.equal(
    buildEmailAddresses(
      {
        ...base,
        senderAddress: "Acme Signing Desk <sign@acme.com>",
      },
      FALLBACK,
    ).senderAddress,
    "Acme Signing Desk <sign@acme.com>",
  );
});

test("characters that mean something in an email header are dropped from the name", () => {
  assert.equal(
    buildEmailAddresses(
      {
        ...base,
        organizationName:
          'Smith, Jones & "Co" <partners>\r\nBcc: x@evil.example',
      },
      FALLBACK,
    ).senderAddress,
    "Smith Jones & Co partners Bcc x evil.example <no-reply@sign.acme.com>",
  );
});

test("a long name is cut without splitting an emoji", () => {
  const senderAddress = buildEmailAddresses(
    {
      ...base,
      organizationName: `${"Acme ".repeat(15)}Acme😀`,
    },
    FALLBACK,
  ).senderAddress;

  assert.equal(
    senderAddress,
    `${"Acme ".repeat(15)}Acme <no-reply@sign.acme.com>`,
  );
  assert.equal(senderAddress, senderAddress.toWellFormed());
});

test("an install with no name, and the hosted service, send as SignuDoc", () => {
  assert.equal(
    buildEmailAddresses({ ...base, organizationName: null }, FALLBACK)
      .senderAddress,
    "SignuDoc <no-reply@sign.acme.com>",
  );
  assert.equal(
    buildEmailAddresses({ ...base, hosted: true }, FALLBACK).senderAddress,
    "SignuDoc <no-reply@sign.acme.com>",
  );
});

test("the capture driver's fallback address is used when one is given", () => {
  assert.equal(
    buildEmailAddresses(base, "dev@signudoc.localhost").senderAddress,
    "Acme Corp <dev@signudoc.localhost>",
  );
});

test("the bare address and its domain can be read back out", () => {
  assert.equal(
    extractEmailAddress("Acme Corp <Sign@Acme.com>"),
    "sign@acme.com",
  );
  assert.equal(extractEmailAddress(" Sign@Acme.com "), "sign@acme.com");
  assert.equal(getAddressDomain("Acme Corp <sign@acme.com>"), "acme.com");
  assert.equal(getAddressDomain("not an address"), null);
  assert.equal(getAddressDomain("sign@"), null);
});
