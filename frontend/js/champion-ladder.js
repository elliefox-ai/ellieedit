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

  // Corner-X removal (2026-11-11 Chunk C): drop an image from the comparison
  // set WITHOUT adding it to `rejected` — removal is not a verdict, so the
  // removed image must never reach the pending-deletion queue. The comparison
  // continues with the remainder. Removing the champion promotes the current
  // challenger (or, with none left, the runner-up) with no duel; removing the
  // challenger just drops it. Returns the removed item, or null if impossible.
  remove(which) {
    if (this.done) return null;
    if (which === 'a') {
      const gone = this.champion;
      if (this.idx < this.challengers.length) {
        this.champion = this.challengers.splice(this.idx, 1)[0];
        if (this.idx >= this.challengers.length) this.done = true;
      } else if (this.runnerUp && this.runnerUp !== gone) {
        this.champion = this.runnerUp;
        this.runnerUp = null;
        this.done = true;
      } else {
        this.champion = null;
        this.done = true;
      }
      if (this.runnerUp === gone) this.runnerUp = null;
      return gone;
    }
    const gone = this.challenger;
    if (!gone) return null;
    this.challengers.splice(this.idx, 1);
    if (this.idx >= this.challengers.length) this.done = true;
    if (this.runnerUp === gone) this.runnerUp = null;
    return gone;
  }

  _advance() {
    this.idx++;
    if (this.idx >= this.challengers.length) this.done = true;
  }
}
