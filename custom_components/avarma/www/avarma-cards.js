// Avarma-Wärmepumpe: Karte für den Display-Nachbau.
// Wrappt die Standard-Karte "picture-elements" und setzt die nötigen Styles selbst
// (dunkler Hintergrund, mitskalierende Schrift über container-type, Dreh-Animation),
// damit kein card-mod nötig ist.
class AvarmaSchemaCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.image) throw new Error("image fehlt");
    this._config = config;
    this._build();
  }

  async _build() {
    const helpers = await window.loadCardHelpers();
    const conf = { ...this._config, type: "picture-elements" };
    const card = await helpers.createCardElement(conf);
    if (this._hass) card.hass = this._hass;
    this._card = card;
    this.replaceChildren(card);
    this._applyStyle(0);
  }

  _applyStyle(tries) {
    const sr = this._card && this._card.shadowRoot;
    const haCard = sr && sr.querySelector("ha-card");
    if (!haCard) {
      if (tries < 100) setTimeout(() => this._applyStyle(tries + 1), 100);
      return;
    }
    Object.assign(haCard.style, {
      background: "#06090d", borderRadius: "16px", overflow: "hidden", containerType: "inline-size",
    });
    if (!sr.querySelector("style[data-avarma]")) {
      const st = document.createElement("style");
      st.dataset.avarma = "1";
      st.textContent = "@keyframes wpspin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";
      sr.appendChild(st);
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._card) {
      this._card.hass = hass;
      this._applyStyle(100); // falls die Karte neu gezeichnet wurde: Styles erneut setzen (ohne Wiederholungen)
    }
  }

  getCardSize() {
    return this._card && this._card.getCardSize ? this._card.getCardSize() : 8;
  }

  getGridOptions() {
    return { columns: "full" };
  }
}

if (!customElements.get("avarma-schema-card")) {
  customElements.define("avarma-schema-card", AvarmaSchemaCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "avarma-schema-card", name: "Avarma Display-Nachbau", description: "Arbeitsstatus wie am Display der Wärmepumpe" });
}
