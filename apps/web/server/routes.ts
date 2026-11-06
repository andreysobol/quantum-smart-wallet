import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress } from "viem";
import { demoUsdcAbi, factoryAbi } from "../shared/abis.js";
import { accountSalt, isPublicKey } from "../shared/account.js";
import { FEES, SIGNATURE_ALGORITHM, SIGNATURE_BYTES, SIGNATURE_CONTEXT, USDC_DECIMALS } from "../shared/constants.js";
import { formatUnits } from "../shared/format.js";
import { cosignAsSponsor, fromWire, FrameTxError, signingHash, toWire, txHash } from "../shared/frameTx.js";
import type { Address, CreateAccountResponse, FaucetResponse, Hex, PublicConfig, SponsorResponse } from "../shared/types.js";
import { defaultContext, type ServerContext } from "./context.js";
import { ApiFailure, BODY_LIMIT, clientIp, enforce, fail, json, readJson, requireSameOriginJson, respond } from "./http.js";
import type { Deployment, Rpc } from "./manifest.js";
import { checkSponsorPolicy, MAX_DEADLINE_SECONDS } from "./policy.js";

export function publicConfig(ctx: ServerContext, d: Deployment): PublicConfig {
  const operatorReady = ctx.env.operatorKey !== null;
  return {
    chainId: d.chainId,
    genesisHash: d.genesisHash,
    nativeProfile: d.nativeProfile,
    rpcUrl: d.rpcUrl,
    mempoolUrl: d.mempoolUrl,
    explorerUrl: d.explorerUrl,
    contracts: d.contracts,
    poolKey: d.poolKey,
    poolId: d.poolId,
    accountInitialStake: d.accountInitialStake.toString(),
    signature: { algorithm: SIGNATURE_ALGORITHM, context: SIGNATURE_CONTEXT, bytes: SIGNATURE_BYTES },
    sponsor: ctx.sponsorAddress,
    operatorReady,
    faucet: { enabled: operatorReady, amount: ctx.env.faucetAmount.toString(), symbol: "dUSDC", decimals: USDC_DECIMALS },
    limits: {
      maxAmountInUsdc: ctx.env.maxSwapUsdc.toString(),
      maxAmountInWeth: ctx.env.maxSwapWeth.toString(),
      maxDeadlineSeconds: MAX_DEADLINE_SECONDS,
    },
    fees: { maxPriorityFeePerGas: FEES.maxPriorityFeePerGas.toString(), maxFeePerGas: FEES.maxFeePerGas.toString() },
  };
}

function field(body: unknown, name: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail(400, "bad_request", "Request body must be a JSON object.");
  return (body as Record<string, unknown>)[name];
}

async function view<T>(rpc: Rpc, to: Address, data: Hex, decode: (result: Hex) => T): Promise<T> {
  return decode(await rpc.call<Hex>("eth_call", [{ to, data }, "latest"]));
}

const isRegistered = (rpc: Rpc, factory: Address, account: Address) =>
  view(rpc, factory, encodeFunctionData({ abi: factoryAbi, functionName: "isAccount", args: [account] }), (data) =>
    decodeFunctionResult({ abi: factoryAbi, functionName: "isAccount", data }),
  );

/** GET /api/config */
export function configRoute(_request: Request, ctx: ServerContext = defaultContext()): Promise<Response> {
  return respond(async () => json(publicConfig(ctx, (await ctx.chain()).deployment)));
}

/** POST /api/account {publicKey}: idempotent; the operator pays the stake for new accounts. */
export function accountRoute(request: Request, ctx: ServerContext = defaultContext()): Promise<Response> {
  return respond(async () => {
    requireSameOriginJson(request);
    if (!ctx.env.operatorKey) fail(503, "not_configured", "Account creation is not available on this server (no operator key configured).");
    enforce(ctx.limits.accountIp, clientIp(request), "account creation");
    const publicKey = field(await readJson(request, BODY_LIMIT.small), "publicKey");
    if (!isPublicKey(publicKey)) fail(400, "bad_request", "publicKey must be a 0x-prefixed, nonzero 32-byte SLH-DSA public key.");
    const pk = (publicKey as Hex).toLowerCase() as Hex;
    const { deployment, rpc, operator } = await ctx.chain();
    if (!operator) return fail(503, "not_configured", "Account creation is not available on this server.");
    const factory = deployment.contracts.accountFactory;
    const salt = accountSalt(pk);
    const account = await view(rpc, factory, encodeFunctionData({ abi: factoryAbi, functionName: "getAddress", args: [pk, salt] }), (data) =>
      decodeFunctionResult({ abi: factoryAbi, functionName: "getAddress", data }),
    );
    const stake = deployment.accountInitialStake;
    const existing: CreateAccountResponse = { account, salt, publicKey: pk, created: false, txHash: null, blockNumber: null, stakeWei: stake.toString() };
    if (await isRegistered(rpc, factory, account)) return json(existing);

    const maxStake = ctx.env.maxAccountStake;
    if (stake > maxStake) {
      fail(503, "operator_unavailable", `The account factory asks for a ${formatUnits(stake, 18)} ETH stake, above this server's limit of ${formatUnits(maxStake, 18)} ETH.`);
    }
    if ((await operator.balance()) < stake + ctx.env.minOperatorBalance) {
      fail(503, "operator_unavailable", "The operator is out of funds for new accounts. Please try again later.");
    }
    let sent: { hash: Hex; blockNumber: number };
    try {
      sent = await operator.send({ to: factory, data: encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [pk, salt] }), value: stake });
    } catch (error) {
      // A concurrent request may have created it first.
      if (await isRegistered(rpc, factory, account).catch(() => false)) return json(existing);
      throw error;
    }
    if (!(await isRegistered(rpc, factory, account))) fail(502, "upstream_error", "The account transaction was mined but the factory does not list the account.");
    const created: CreateAccountResponse = { ...existing, created: true, txHash: sent.hash, blockNumber: sent.blockNumber };
    return json(created);
  });
}

/** POST /api/faucet {account}: mint test dUSDC to a registered account below the balance cap. */
export function faucetRoute(request: Request, ctx: ServerContext = defaultContext()): Promise<Response> {
  return respond(async () => {
    requireSameOriginJson(request);
    if (!ctx.env.operatorKey) fail(503, "not_configured", "The faucet is not available on this server (no operator key configured).");
    enforce(ctx.limits.faucetIp, clientIp(request), "faucet");
    const raw = field(await readJson(request, BODY_LIMIT.small), "account");
    if (typeof raw !== "string" || !isAddress(raw, { strict: false })) fail(400, "bad_request", "account must be a 0x-prefixed 20-byte address.");
    const account = getAddress(raw as string);
    const { deployment, rpc, operator } = await ctx.chain();
    if (!operator) return fail(503, "not_configured", "The faucet is not available on this server.");
    const usdc = deployment.contracts.demoUSDC;
    if (!(await isRegistered(rpc, deployment.contracts.accountFactory, account))) {
      fail(403, "not_quantum_account", "Only QuantumAccounts created by this wallet's factory can use the faucet.");
    }
    const balance = await view(rpc, usdc, encodeFunctionData({ abi: demoUsdcAbi, functionName: "balanceOf", args: [account] }), (data) =>
      decodeFunctionResult({ abi: demoUsdcAbi, functionName: "balanceOf", data }),
    );
    const cap = ctx.env.faucetMaxBalance;
    if (balance >= cap) {
      fail(422, "policy_rejected", `This account already holds ${formatUnits(balance, USDC_DECIMALS, 2)} dUSDC; the faucet only tops up balances below ${formatUnits(cap, USDC_DECIMALS)} dUSDC.`);
    }
    const minter = await view(rpc, usdc, encodeFunctionData({ abi: demoUsdcAbi, functionName: "MINTER" }), (data) =>
      decodeFunctionResult({ abi: demoUsdcAbi, functionName: "MINTER", data }),
    );
    if (minter.toLowerCase() !== operator.address.toLowerCase()) fail(503, "operator_unavailable", "The operator key is not the dUSDC minter.");
    // Charged only when this request mints: anyone can name any account, so refusals must not use up its allowance.
    enforce(ctx.limits.faucetAccount, account.toLowerCase(), "faucet");
    const amount = ctx.env.faucetAmount;
    const sent = await operator.send({ to: usdc, data: encodeFunctionData({ abi: demoUsdcAbi, functionName: "mint", args: [account, amount] }) });
    const body: FaucetResponse = { account, token: usdc, amount: amount.toString(), txHash: sent.hash, blockNumber: sent.blockNumber };
    return json(body);
  });
}

/** POST /api/sponsor {tx}: strict policy, then co-sign. The server never submits the transaction. */
export function sponsorRoute(request: Request, ctx: ServerContext = defaultContext()): Promise<Response> {
  return respond(async () => {
    requireSameOriginJson(request);
    if (!ctx.env.sponsorKey) fail(503, "not_configured", "Swap sponsorship is not available on this server (no sponsor key configured).");
    enforce(ctx.limits.sponsorIp, clientIp(request), "sponsorship");
    const wire = field(await readJson(request, BODY_LIMIT.sponsor), "tx");
    let tx;
    try {
      tx = fromWire(wire);
    } catch (error) {
      if (error instanceof FrameTxError) return fail(400, "bad_request", `Invalid transaction: ${error.message}.`);
      throw error;
    }
    const { deployment, rpc, sponsor } = await ctx.chain();
    if (!sponsor) return fail(503, "not_configured", "Swap sponsorship is not available on this server.");
    const env = ctx.env;
    await checkSponsorPolicy(tx, { deployment, sponsor: sponsor.address, maxSwapUsdc: env.maxSwapUsdc, maxSwapWeth: env.maxSwapWeth, reserve: env.minOperatorBalance, rpc });
    // Charged only now that the account's SLH-DSA signature verified, so naming someone else's account
    // costs it nothing. A signed swap is public once submitted: replaying it is not charged again.
    const digest = signingHash(tx);
    if (!ctx.cosigned.has(digest)) {
      enforce(ctx.limits.sponsorAccount, tx.sender, "sponsorship");
      ctx.cosigned.add(digest);
    }
    const signed = await cosignAsSponsor(tx, sponsor).catch((error: unknown) => {
      throw new ApiFailure(500, "internal", `Co-signing failed: ${error instanceof Error ? error.message : "unknown error"}.`);
    });
    const body: SponsorResponse = { sponsor: sponsor.address, signingHash: digest, txHash: txHash(signed), tx: toWire(signed) };
    return json(body);
  });
}
