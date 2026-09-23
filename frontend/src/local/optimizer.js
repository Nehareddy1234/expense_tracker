// Ported from backend/app/optimizer.py (scipy linprog). This LP
// (minimise sum(x_i * pain_i) s.t. sum(x_i) >= deficit, 0 <= x_i <= cap_i)
// is solved exactly by filling donors in ascending pain order — no solver needed.

export function capacityPaise(d) {
  if (d.locked || d.balance_paise <= 0) return 0
  return Math.floor((d.balance_paise * d.flexibility_pct) / 100)
}

export function planRebalance(deficitPaise, donors) {
  if (deficitPaise <= 0) {
    return { moves: [], total_pain: 0, pain_score: 0, feasible: true }
  }
  const caps = donors.map(capacityPaise)
  const totalCap = caps.reduce((a, b) => a + b, 0)
  if (totalCap < deficitPaise) {
    return { moves: [], total_pain: 0, pain_score: 0, feasible: false }
  }
  const x = caps.map(() => 0)
  let need = deficitPaise
  const order = donors
    .map((d, i) => i)
    .sort((a, b) => donors[a].pain - donors[b].pain || caps[b] - caps[a])
  for (const i of order) {
    if (need <= 0) break
    const take = Math.min(caps[i], need)
    x[i] = take
    need -= take
  }
  const total = x.reduce((a, b) => a + b, 0)
  const totalPain = donors.reduce((acc, d, i) => acc + x[i] * d.pain, 0)
  const moves = donors
    .map((d, i) => [d.id, x[i]])
    .filter(([, amt]) => amt > 0)
    .sort((a, b) => a[0] - b[0])
  return {
    moves,
    total_pain: totalPain,
    pain_score: Math.round((totalPain / (100 * total)) * 100) / 100,
    feasible: true,
  }
}

// Mirror of backend/app/optimizer.py plan_budget_set: turn user-set envelope
// targets into moves. Surplus above an explicit target donates first (lowest
// pain first); Unallocated money only tops up the rest. { moves, short }.
export function planBudgetSet(targets, balances, unallocatedPaise) {
  const needs = []
  const donors = []
  for (const [cidStr, target] of Object.entries(targets)) {
    const cid = Number(cidStr)
    const bal = balances[cid] ? balances[cid].balance_paise : 0
    if (target > bal) needs.push([cid, target - bal])
    else if (bal > target) donors.push([cid, bal - target])
  }
  donors.sort((a, b) => balances[a[0]].pain_weight - balances[b[0]].pain_weight || b[1] - a[1])

  const moves = []
  let pool = unallocatedPaise
  let short = 0
  for (const [cid, need0] of needs.sort((a, b) => a[0] - b[0])) {
    let need = need0
    for (const donor of donors) {
      if (need <= 0) break
      const give = Math.min(donor[1], need)
      if (give) {
        moves.push({ from: donor[0], to: cid, amount: give })
        donor[1] -= give
        need -= give
      }
    }
    const take = Math.min(pool, need)
    if (take) {
      moves.push({ from: null, to: cid, amount: take })
      pool -= take
      need -= take
    }
    short += need
  }
  return { moves, short }
}
