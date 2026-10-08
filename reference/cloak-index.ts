import type { Coverage, Counterparty, DnaProfile, CloakIndex, LabelSupport, PublicLabel, ScoreComponent, WalletBalances } from './types'

/**
 * CLOAK INDEX — methodology v1.
 *
 * An observational exposure index, 0–100. Higher means MORE exposure
 * indicators were observed in the analyzed dataset. It is not a privacy
 * certification, a security rating or a statement about who owns a wallet.
 *
 * Each component maps one observable indicator to a 0..1 strength. The score
 * is the weighted mean of the components that could be evaluated, scaled to
 * 100. Components that cannot be evaluated (not enough data, or a data
 * source that is unavailable) are excluded and their weight is NOT counted
 * as zero — missing data never makes a wallet look private.
 *
 * Pure and deterministic: the same inputs always produce the same score.
 */
export const METHODOLOGY_VERSION = 'cloak-index/1.0'

/** Minimum successful, timestamped transactions before any score is shown. */
export const MIN_TX_FOR_SCORE = 10
/** Minimum share of total weight that must be evaluable. */
export const MIN_EVALUATED_WEIGHT = 60

export interface ScoreWeights {
  holdings: number
  repeated: number
  concentration: number
  temporal: number
  programs: number
  trading: number
  labels: number
}

export const WEIGHTS: ScoreWeights = {
  holdings: 15,
  repeated: 20,
  concentration: 15,
  temporal: 15,
  programs: 10,
  trading: 15,
  labels: 10,
}

export const THRESHOLDS = {
  /** Holdings count at which visibility saturates (NFTs count half). */
  holdingsSaturation: 10,
  /** A counterparty is "repeated" at this many shared transactions. */
  repeatedMinTx: 3,
  /** Repeated-counterparty count at which the indicator saturates. */
  repeatedSaturation: 6,
  /** Counterparty interactions needed before concentration is meaningful. */
  concentrationMinInteractions: 5,
  /** Distinct non-infrastructure programs at which footprint saturates. */
  programsSaturation: 10,
  /** Swaps at which trading visibility saturates. */
  tradingSaturation: 15,
  /** Labeled-counterparty transactions at which labeling saturates. */
  labelsSaturation: 5,
}

export interface ScoreInput {
  coverage: Coverage
  balances: WalletBalances
  counterparties: Counterparty[]
  dna: DnaProfile
  labelSupport: LabelSupport
  walletLabel: PublicLabel | null
  /** Successful transactions with a block time. */
  timedSuccessCount: number
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function scoreBand(value: number): 'low' | 'moderate' | 'elevated' | 'high' {
  if (value < 25) return 'low'
  if (value < 50) return 'moderate'
  if (value < 75) return 'elevated'
  return 'high'
}

export function computeComponents(input: ScoreInput, w: ScoreWeights = WEIGHTS): Omit<ScoreComponent, 'points'>[] {
  const { balances, counterparties, dna, labelSupport, walletLabel, timedSuccessCount } = input
  const T = THRESHOLDS

  const fungible = balances.holdings.filter((h) => h.kind === 'fungible').length
  const nfts = balances.holdings.filter((h) => h.kind === 'nft').length
  const holdingsUnits = fungible + nfts * 0.5 + (balances.lamports > 0 ? 1 : 0)

  const repeated = counterparties.filter((c) => c.txCount >= T.repeatedMinTx).length
  const interactions = counterparties.reduce((a, c) => a + c.txCount, 0)
  const distinctPrograms = dna.programs.length

  const labelEvaluable = labelSupport === 'supported' || labelSupport === 'demo'
  const labeledTx = counterparties.filter((c) => c.label).reduce((a, c) => a + c.txCount, 0)

  // Expected share of a 4h window under perfectly uniform activity is 4/24.
  const uniform = 4 / 24

  return [
    {
      key: 'holdings',
      label: 'Visible holdings',
      weight: w.holdings,
      raw: clamp01(holdingsUnits / T.holdingsSaturation),
      basis: `${fungible} fungible, ${nfts} NFT, SOL ${balances.lamports > 0 ? 'present' : 'empty'} — saturates at ${T.holdingsSaturation}`,
    },
    {
      key: 'repeated',
      label: 'Repeated counterparties',
      weight: w.repeated,
      raw: clamp01(repeated / T.repeatedSaturation),
      basis: `${repeated} counterparties with ≥${T.repeatedMinTx} shared transactions — saturates at ${T.repeatedSaturation}`,
    },
    {
      key: 'concentration',
      label: 'Relationship concentration',
      weight: w.concentration,
      raw: interactions >= T.concentrationMinInteractions ? clamp01(dna.top3CounterpartyShare) : null,
      basis:
        interactions >= T.concentrationMinInteractions
          ? `Top 3 counterparties hold ${(dna.top3CounterpartyShare * 100).toFixed(0)}% of ${interactions} transfer interactions`
          : `Not evaluated — ${interactions} interactions (needs ${T.concentrationMinInteractions})`,
    },
    {
      key: 'temporal',
      label: 'Activity rhythm',
      weight: w.temporal,
      raw: timedSuccessCount >= MIN_TX_FOR_SCORE ? clamp01((dna.peakWindowShare - uniform) / (1 - uniform)) : null,
      basis:
        timedSuccessCount >= MIN_TX_FOR_SCORE
          ? `${(dna.peakWindowShare * 100).toFixed(0)}% of activity in the busiest 4h UTC window (uniform ≈ 17%)`
          : 'Not evaluated — too few timestamped transactions',
    },
    {
      key: 'programs',
      label: 'Program footprint',
      weight: w.programs,
      raw: clamp01(distinctPrograms / T.programsSaturation),
      basis: `${distinctPrograms} distinct non-infrastructure programs — saturates at ${T.programsSaturation}`,
    },
    {
      key: 'trading',
      label: 'Public trading',
      weight: w.trading,
      raw: clamp01(dna.trading.swapCount / T.tradingSaturation),
      basis: `${dna.trading.swapCount} swaps observed — saturates at ${T.tradingSaturation}`,
    },
    {
      key: 'labels',
      label: 'Public labeling',
      weight: w.labels,
      raw: labelEvaluable ? (walletLabel ? 1 : clamp01(labeledTx / T.labelsSaturation)) : null,
      basis: !labelEvaluable
        ? labelSupport === 'unsupported-plan'
          ? 'Not evaluated — identity labels require a paid Helius plan'
          : 'Not evaluated — label source unavailable'
        : walletLabel
          ? `Analyzed address itself carries a public label`
          : `${labeledTx} transactions with publicly labeled counterparties`,
    },
  ]
}

export function computeCloakIndex(input: ScoreInput, w: ScoreWeights = WEIGHTS): CloakIndex {
  const comps = computeComponents(input, w)
  const evaluated = comps.filter((c) => c.raw !== null)
  const evaluatedWeight = evaluated.reduce((a, c) => a + c.weight, 0)
  const totalWeight = comps.reduce((a, c) => a + c.weight, 0)
  const evaluatedShare = totalWeight ? (evaluatedWeight / totalWeight) * 100 : 0

  const components: ScoreComponent[] = comps.map((c) => ({
    ...c,
    points: c.raw === null || !evaluatedWeight ? 0 : round2((c.weight * c.raw * 100) / evaluatedWeight),
  }))

  if (input.timedSuccessCount < MIN_TX_FOR_SCORE) {
    return {
      status: 'insufficient',
      value: null,
      reason: `Only ${input.timedSuccessCount} successful timestamped transactions in the analyzed window; at least ${MIN_TX_FOR_SCORE} are required.`,
      components,
      methodologyVersion: METHODOLOGY_VERSION,
    }
  }
  if (evaluatedShare < MIN_EVALUATED_WEIGHT) {
    return {
      status: 'insufficient',
      value: null,
      reason: `Only ${evaluatedShare.toFixed(0)}% of indicator weight could be evaluated; at least ${MIN_EVALUATED_WEIGHT}% is required.`,
      components,
      methodologyVersion: METHODOLOGY_VERSION,
    }
  }

  const weighted = evaluated.reduce((a, c) => a + c.weight * (c.raw as number), 0)
  const value = Math.round((weighted / evaluatedWeight) * 100)
  return {
    status: 'scored',
    value,
    band: scoreBand(value),
    components,
    evaluatedWeight: round2(evaluatedShare),
    methodologyVersion: METHODOLOGY_VERSION,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
