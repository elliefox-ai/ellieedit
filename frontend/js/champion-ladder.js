// Champion-ladder compare state machine (pure, no DOM — node-testable).
// First selected image = CHAMPION. Each other image cycles through as
// CHALLENGER. "Keep Champion" discards the challenger; "Keep Challenger"
// promotes it and discards the old champion. The last image that lost to the
// champion is kept as runner-up so Blend always has two images.

export class ChampionLadder {
  constructor(items) {
    if (!items || items.length < 2) throw new Error('need at least 2 images');
    this.champion = items[0];
    this.challengers = items.slice(1);
    this.idx = 0;          // 0-based challenger position (k-1)
    this.rejected = [];    // {item, lostTo} history
    this.runnerUp = null;  // last image that lost to the champion
    this.done = false;
  }

  get total() { return this.challengers.length + 1; }
  get k() { return this.idx + 1; }          // 1-based challenger number
  get challenger() {
    return this.done || this.idx >= this.challengers.length ? null : this.challengers[this.idx];
  }

  // Operator keeps the champion: challenger is discarded, next loads.
  keepChampion() {
    const c = this.challenger;
    if (!c) return;
    this.rejected.push({ item: c, lostTo: this.champion });
    this.runnerUp = c;
    this._advance();
  }

  // Operator keeps the challenger: it becomes champion, old champion discarded.
  keepChallenger() {
    const c = this.challenger;
    if (!c) return;
    this.rejected.push({ item: this.champion, lostTo: c });
    this.runnerUp = this.champion;
    this.champion = c;
    this._advance();
  }

  // Let the operator swap the Blend partner to any rejected image.
  setRunnerUp(item) {
    if (item) this.runnerUp = item;
  }

  _advance() {
    this.idx++;
    if (this.idx >= this.challengers.length) this.done = true;
  }
}
