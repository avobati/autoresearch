"use client";

import { useEffect, useMemo, useState } from "react";
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

type WithdrawalAction = (formData: FormData) => Promise<void>;

type Props = {
  treasuryAddress: string | null;
  network: string;
  rpcUrl: string | null;
  createWithdrawalRequestAction: WithdrawalAction;
  recordWalletDepositAction: WithdrawalAction;
};

type SolanaWalletProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: PublicKey;
  isConnected?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signAndSendTransaction?: (tx: Transaction) => Promise<{ signature: string } | string>;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
};

declare global {
  interface Window {
    solana?: SolanaWalletProvider;
    phantom?: { solana?: SolanaWalletProvider };
    solflare?: SolanaWalletProvider;
  }
}

function getProvider(): SolanaWalletProvider | null {
  if (typeof window === "undefined") return null;
  const candidate = window.phantom?.solana ?? window.solana ?? window.solflare ?? null;
  if (!candidate?.connect || (!candidate?.signAndSendTransaction && !candidate?.signTransaction)) return null;
  return candidate;
}

function clusterFromNetwork(network: string) {
  if (network === "devnet") return "devnet";
  if (network === "testnet") return "testnet";
  return "mainnet-beta";
}

function shortAddress(value: string | null) {
  if (!value) return "Not connected";
  if (value.length < 13) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function buildRpcEndpoints(network: string, rpcUrl: string | null) {
  const primary = rpcUrl?.trim() ? [rpcUrl.trim()] : [];
  const cluster = clusterApiUrl(clusterFromNetwork(network));
  if (network === "devnet") {
    return Array.from(new Set([...primary, cluster]));
  }
  if (network === "testnet") {
    return Array.from(new Set([...primary, cluster]));
  }
  // Public fallback set for mainnet to reduce single-endpoint failures in browser contexts.
  return Array.from(
    new Set([
      ...primary,
      cluster,
      "https://rpc.ankr.com/solana",
      "https://solana-rpc.publicnode.com",
    ])
  );
}

function isRpcForbiddenError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("403") || error.message.toLowerCase().includes("access forbidden");
}

export function SolanaWalletPanel({
  treasuryAddress,
  network,
  rpcUrl,
  createWithdrawalRequestAction,
  recordWalletDepositAction,
}: Props) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState(false);
  const [pendingDeposit, setPendingDeposit] = useState(false);
  const [depositSol, setDepositSol] = useState("0.1");
  const [depositStatus, setDepositStatus] = useState<string | null>(null);
  const [depositSig, setDepositSig] = useState<string | null>(null);
  const [depositUsd, setDepositUsd] = useState("");

  const providerAvailable = useMemo(() => Boolean(getProvider()), []);
  const rpcEndpoints = useMemo(() => buildRpcEndpoints(network, rpcUrl), [network, rpcUrl]);

  useEffect(() => {
    const provider = getProvider();
    if (!provider?.isConnected || !provider.publicKey) return;
    setWalletAddress(provider.publicKey.toBase58());
  }, []);

  async function onConnectWallet() {
    const provider = getProvider();
    if (!provider) {
      setWalletError("No Solana wallet extension found. Install Phantom or Solflare.");
      return;
    }
    setWalletError(null);
    setPendingConnect(true);
    try {
      const result = await provider.connect();
      setWalletAddress(result.publicKey.toBase58());
    } catch {
      setWalletError("Wallet connection was cancelled or failed.");
    } finally {
      setPendingConnect(false);
    }
  }

  async function onDisconnectWallet() {
    const provider = getProvider();
    if (!provider) return;
    try {
      await provider.disconnect();
    } catch {
      // no-op
    }
    setWalletAddress(null);
    setDepositStatus(null);
    setDepositSig(null);
  }

  async function onDeposit() {
    const provider = getProvider();
    if (!provider || !walletAddress) {
      setDepositStatus("Connect your wallet first.");
      return;
    }
    if (!treasuryAddress) {
      setDepositStatus("Treasury address is not configured.");
      return;
    }
    const amount = Number(depositSol);
    if (!Number.isFinite(amount) || amount <= 0) {
      setDepositStatus("Enter a valid SOL amount.");
      return;
    }

    setPendingDeposit(true);
    setDepositStatus(null);
    setDepositSig(null);
    try {
      let connection: Connection | null = null;
      let latest: { blockhash: string; lastValidBlockHeight: number } | null = null;
      const rpcErrors: string[] = [];

      for (const endpoint of rpcEndpoints) {
        try {
          const candidate = new Connection(endpoint, "confirmed");
          const blockhash = await candidate.getLatestBlockhash("finalized");
          connection = candidate;
          latest = blockhash;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          rpcErrors.push(`${endpoint}: ${msg}`);
        }
      }

      if (!connection || !latest) {
        throw new Error(`Unable to reach a Solana RPC endpoint. ${rpcErrors.join(" | ")}`);
      }

      const from = new PublicKey(walletAddress);
      const to = new PublicKey(treasuryAddress);
      const lamports = Math.round(amount * LAMPORTS_PER_SOL);

      try {
        const balance = await connection.getBalance(from, "confirmed");
        const feeBuffer = 10_000;
        if (balance < lamports + feeBuffer) {
          setDepositStatus("Insufficient SOL balance for amount + network fee.");
          setPendingDeposit(false);
          return;
        }
      } catch (error) {
        if (!isRpcForbiddenError(error)) {
          const msg = error instanceof Error ? error.message : String(error);
          setDepositStatus(`Balance check skipped: ${msg}`);
        }
      }

      const tx = new Transaction();
      tx.feePayer = from;
      tx.recentBlockhash = latest.blockhash;
      tx.add(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: to,
          lamports,
        })
      );

      let signature: string | null = null;
      if (provider.signAndSendTransaction) {
        const result = await provider.signAndSendTransaction(tx);
        signature = typeof result === "string" ? result : result.signature;
      } else if (provider.signTransaction) {
        const signed = await provider.signTransaction(tx);
        signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
      }
      if (!signature) {
        throw new Error("Wallet did not return a transaction signature.");
      }

      setDepositSig(signature);
      setDepositUsd("");

      try {
        await connection.confirmTransaction(signature, "confirmed");
        setDepositStatus("Deposit confirmed on-chain. Use Notify Funding Intent below to record it in the dashboard.");
      } catch {
        setDepositStatus(
          "Transaction submitted. Confirmation is pending or RPC is rate-limited; check the tx link and wallet activity."
        );
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Deposit failed or was rejected in wallet.";
      setDepositStatus(`Deposit error: ${message}`);
    } finally {
      setPendingDeposit(false);
    }
  }

  return (
    <div className="wallet-panel">
      <h3>Secure Wallet Mode</h3>
      <p className="wallet-note">
        Connect your own wallet to sign transactions locally. Private keys never enter this website.
      </p>
      <p>
        Connected wallet: <span className="mono">{shortAddress(walletAddress)}</span>
      </p>
      {!providerAvailable && (
        <p className="empty">
          No wallet provider detected. Install Phantom or Solflare to use direct signed deposits.
        </p>
      )}
      {walletError && <p className="empty">{walletError}</p>}

      <div className="wallet-actions">
        <button type="button" onClick={onConnectWallet} disabled={pendingConnect || !providerAvailable}>
          {pendingConnect ? "Connecting..." : "Connect Wallet"}
        </button>
        <button type="button" onClick={onDisconnectWallet} disabled={!walletAddress}>
          Disconnect
        </button>
      </div>

      <div className="fund-form">
        <label>
          Deposit Amount (SOL)
          <input
            type="number"
            min="0.001"
            step="0.001"
            value={depositSol}
            onChange={(e) => setDepositSol(e.target.value)}
          />
        </label>
        <button type="button" onClick={onDeposit} disabled={pendingDeposit || !walletAddress || !treasuryAddress}>
          {pendingDeposit ? "Submitting..." : "Deposit From Connected Wallet"}
        </button>
      </div>

      {depositStatus && <p className="wallet-note">{depositStatus}</p>}
      {depositSig && (
        <>
          <p className="wallet-note">
            Tx:{" "}
            <a href={`https://solscan.io/tx/${depositSig}`} target="_blank" rel="noreferrer">
              {depositSig}
            </a>
          </p>
          <form action={recordWalletDepositAction} className="fund-form">
            <input type="hidden" name="tx_ref" value={depositSig} />
            <label>
              USD value to record
              <input
                name="amount_usd"
                type="number"
                min="1"
                step="0.01"
                required
                value={depositUsd}
                onChange={(e) => setDepositUsd(e.target.value)}
                placeholder="Enter USD value of this deposit"
              />
            </label>
            <label>
              Note
              <input
                name="note"
                type="text"
                maxLength={200}
                defaultValue={`Wallet deposit ${depositSig.slice(0, 8)}...`}
              />
            </label>
            <button type="submit">Record Deposit On Dashboard</button>
          </form>
        </>
      )}

      <h3>Backfill Existing Deposit</h3>
      <form action={recordWalletDepositAction} className="fund-form">
        <label>
          Deposit tx signature
          <input name="tx_ref" type="text" minLength={20} required placeholder="Paste confirmed Solana tx signature" />
        </label>
        <label>
          USD value to record
          <input name="amount_usd" type="number" min="1" step="0.01" required />
        </label>
        <label>
          Note
          <input name="note" type="text" maxLength={200} defaultValue="Backfilled wallet deposit" />
        </label>
        <button type="submit">Backfill Deposit To Dashboard</button>
      </form>

      <h3>Withdraw To Connected Wallet</h3>
      <form action={createWithdrawalRequestAction} className="fund-form">
        <label>
          Amount (USD)
          <input name="amount_usd" type="number" min="1" step="1" required />
        </label>
        <label>
          Asset
          <select name="asset" defaultValue="USDC" required>
            <option value="USDC">USDC</option>
            <option value="SOL">SOL</option>
          </select>
        </label>
        <label>
          Destination wallet
          <input
            name="destination_address"
            type="text"
            value={walletAddress ?? ""}
            readOnly
            required
            placeholder="Connect wallet to populate"
          />
        </label>
        <label>
          Note
          <input name="note" type="text" maxLength={200} placeholder="e.g. Transfer to my wallet" />
        </label>
        <button type="submit" disabled={!walletAddress}>
          Request Withdrawal To Connected Wallet
        </button>
      </form>
    </div>
  );
}
