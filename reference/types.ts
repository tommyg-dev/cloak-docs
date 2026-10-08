/**
 * Stable domain models. Every provider response is normalized into these
 * shapes before any analysis runs, so the analysis layer never sees Helius
 * field names and the demo dataset can travel through the exact same code.
 */

export type DataMode = 'live' | 'demo'

export type Severity = 'low' | 'medium' | 'high'
export type Confidence = 'low' | 'medium' | 'high'

/** A SOL movement in lamports. Either side may be unknown. */
export interface NativeMove {
  from: string | null
  to: string | null
  lamports: number
}

/** An SPL / Token-2022 movement. `amount` is UI units (raw / 10^decimals). */
export interface TokenMove {
  from: string | null
  to: string | null
  mint: string
  amount: number
  decimals: number
}

export type ActivityKind =
  | 'transfer'
  | 'swap'
  | 'liquidity'
  | 'account'
  | 'program'
  | 'failed'
  | 'unknown'

/** One normalized on-chain transaction touching the analyzed wallet. */
export interface NormalizedTx {
  signature: string
  /** Unix seconds. null when the provider has no block time. */
  timestamp: number | null
  slot: number
  feeLamports: number
  feePayer: string | null
  success: boolean
  kind: ActivityKind
  /** Provider summary type verbatim (e.g. "swap", "transfer"), when present. */
  summaryType: string | null
  /** Swap/liquidity venue reported by the provider (e.g. "jupiter"). */
  protocol: string | null
  description: string | null
  nativeMoves: NativeMove[]
  tokenMoves: TokenMove[]
  /** Distinct top-level + inner program ids, in first-seen order. */
  programs: { id: string; name: string | null }[]
  /** Swap input/output mints when the provider reports them. */
  swap: { inputMint: string | null; outputMint: string | null } | null
}

export interface Holding {
  mint: string
  symbol: string | null
  name: string | null
  amount: number
  decimals: number
  /** USD value as reported by the provider; null when no price is published. */
  usdValue: number | null
  kind: 'fungible' | 'nft'
}

export interface WalletBalances {
  address: string
  lamports: number
  sol: number
  /** USD value of SOL when the provider publishes a price; null otherwise. */
  solUsd: number | null
  holdings: Holding[]
  /** True when the holdings list hit the server-side cap. */
  truncated: boolean
  fetchedAt: string
}

export interface PublicLabel {
  address: string
  name: string
  category: string | null
  type: string | null
  /** Who asserted the label. CLOAK never invents one. */
  source: 'helius-identity' | 'demo'
}

export type LabelSupport = 'supported' | 'unsupported-plan' | 'unavailable' | 'demo'

export interface Coverage {
  txCount: number
  successCount: number
  failedCount: number
  /** Unix seconds of the oldest / newest analyzed transaction. */
  oldest: number | null
  newest: number | null
  spanDays: number
  pagesFetched: number
  requestedLimit: number
  /** True when the window was capped before reaching the start of history. */
  limitReached: boolean
  fetchedAt: string
}

export interface EvidenceRef {
  /** tx = transaction signature, account = an address, token = a mint. */
  kind: 'tx' | 'account' | 'token'
  ref: string
  timestamp: number | null
  note: string
}

export interface Counterparty {
  address: string
  /** in = counterparty sent to the wallet, out = wallet sent to counterparty. */
  inCount: number
  outCount: number
  /** Transactions in which this counterparty appeared on a transfer leg. */
  txCount: number
  solIn: number
  solOut: number
  tokenMoves: number
  mints: string[]
  firstSeen: number | null
  lastSeen: number | null
  label: PublicLabel | null
  evidence: EvidenceRef[]
}

export interface ProgramUse {
  id: string
  name: string | null
  txCount: number
  share: number
}

export interface DnaProfile {
  /** [dayOfWeek 0=Sun][hourUTC] transaction counts. */
  heatmap: number[][]
  hourly: number[]
  weekday: number[]
  /** Daily counts across the coverage window (UTC dates). */
  daily: { date: string; count: number }[]
  kindMix: { kind: ActivityKind; count: number }[]
  protocolMix: { protocol: string; count: number }[]
  programs: ProgramUse[]
  /** Median seconds between consecutive transactions. */
  medianGapSeconds: number | null
  /** Share of transactions inside the busiest contiguous 4-hour UTC window. */
  peakWindowShare: number
  peakWindowStartHour: number | null
  /** Herfindahl-Hirschman index over counterparty interaction counts, 0..1. */
  counterpartyHhi: number
  top3CounterpartyShare: number
  trading: {
    swapCount: number
    distinctMintsTraded: number
    venues: { protocol: string; count: number }[]
    topPairs: { pair: string; count: number }[]
  }
  transfersPerWeek: number | null
}

export interface GraphNode {
  id: string
  role: 'center' | 'counterparty' | 'second-hop'
  label: PublicLabel | null
  txCount: number
  hop: 0 | 1 | 2
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  /** Number of transactions with a transfer leg in this direction. */
  count: number
  sol: number
  tokenMoves: number
  evidence: EvidenceRef[]
}

export interface WalletGraph {
  center: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  depth: 1 | 2
  /** True when node/edge caps removed observed relationships. */
  truncated: boolean
  limits: { maxNodes: number; maxSecondHopSeeds: number; secondHopTxPerSeed: number }
}

export type SignalCategory =
  | 'holdings'
  | 'repeated-counterparty'
  | 'concentration'
  | 'temporal'
  | 'program'
  | 'trading'
  | 'labeling'
  | 'funding'
  | 'recurring'

export interface ExposureSignal {
  id: string
  category: SignalCategory
  title: string
  severity: Severity
  confidence: Confidence
  observation: string
  evidence: EvidenceRef[]
  limitation: string
  recommendation: string
  /** Addresses this signal is about (counterparties, mints). */
  subjects: string[]
}

export interface ScoreComponent {
  key: string
  label: string
  weight: number
  /** Normalized 0..1 indicator strength, or null when not evaluated. */
  raw: number | null
  /** Points contributed after renormalization. */
  points: number
  basis: string
}

export type CloakIndex =
  | {
      status: 'scored'
      value: number
      band: 'low' | 'moderate' | 'elevated' | 'high'
      components: ScoreComponent[]
      evaluatedWeight: number
      methodologyVersion: string
    }
  | {
      status: 'insufficient'
      value: null
      reason: string
      components: ScoreComponent[]
      methodologyVersion: string
    }

export interface ScanReport {
  id: string
  address: string
  mode: DataMode
  generatedAt: string
  balances: WalletBalances
  coverage: Coverage
  counterparties: Counterparty[]
  counterpartyTotal: number
  graph: WalletGraph
  dna: DnaProfile
  signals: ExposureSignal[]
  score: CloakIndex
  labelSupport: LabelSupport
  walletLabel: PublicLabel | null
  methodologyVersion: string
  /** Recent transactions for the evidence table (bounded). */
  recent: NormalizedTx[]
}

export type ScanStage = 'connecting' | 'retrieving' | 'mapping' | 'analyzing' | 'reporting'

export const SCAN_STAGES: { id: ScanStage; label: string; work: string }[] = [
  { id: 'connecting', label: 'Establishing Connection', work: 'Validate the address, select the data source and confirm credentials' },
  { id: 'retrieving', label: 'Retrieving Public Activity', work: 'Page through parsed transaction history and read balances' },
  { id: 'mapping', label: 'Mapping Transactions', work: 'Normalize transactions, aggregate counterparties, look up public labels' },
  { id: 'analyzing', label: 'Analyzing Exposure', work: 'Build Wallet DNA, derive exposure signals, compute the CLOAK Index' },
  { id: 'reporting', label: 'Generating Intelligence Report', work: 'Assemble the trace map and the CLOAK Intelligence Report' },
]

export type ScanEvent =
  | { type: 'stage'; stage: ScanStage; status: 'start' | 'done'; detail?: string; at: number }
  | { type: 'progress'; stage: ScanStage; detail: string; at: number }
  | { type: 'result'; report: ScanReport }
  | { type: 'error'; stage: ScanStage | null; code: string; message: string; retryable: boolean }
