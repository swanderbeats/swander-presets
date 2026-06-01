/**
 * meta-buy-button.js (v3)
 * - Works anywhere (not only product pages) as long as the Liquid snippet renders a form with:
 *   - [data-meta-buy-form]
 *   - hidden input name="id" (variant id)
 *   - optional quantity input name="quantity"
 *
 * Redirect behavior:
 *   - Uses (in priority) data-redirect-to, data-redirect_to, data-redirect, data-redirectTo
 *   - Values: "drawer" | "cart" | "checkout"
 *
 * v3 changes (cart reliability fix):
 * - Add-to-cart and the post-add UI work are now isolated: a failure while refreshing
 *   the cart sections can no longer prevent the drawer from opening / the redirect.
 * - "drawer" mode opens the native Concept <cart-drawer> robustly (event + direct show()),
 *   and if the drawer can't be opened it falls back to the /cart page so the customer
 *   ALWAYS gets clear feedback and a working checkout button.
 */

(() => {
  "use strict";

  // -----------------------------
  // Sections helpers (Concept)
  // -----------------------------
  function getSectionsToBundle() {
    const sections = [];
    document.documentElement.dispatchEvent(
      new CustomEvent("cart:bundled-sections", {
        bubbles: true,
        detail: { sections },
      })
    );
    return sections;
  }

  async function fetchCartSections(sections) {
    const res = await fetch(theme.routes.cart_update_url, {
      ...theme.utils.fetchConfig("json"),
      body: JSON.stringify({ sections }),
    });

    const data = await res.json();
    if (!res.ok) throw data;
    return data;
  }

  function publishCartUpdate(parsedState) {
    if (theme?.pubsub?.publish && theme?.pubsub?.PUB_SUB_EVENTS?.cartUpdate) {
      theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, {
        source: "meta-buy-button",
        cart: parsedState,
      });
    }

    document.dispatchEvent(
      new CustomEvent("cart:updated", {
        detail: { cart: parsedState },
      })
    );
  }

  function cartUrl() {
    return (theme && theme.routes && theme.routes.cart_url) || "/cart";
  }

  function isDrawerOpen(drawer) {
    if (!drawer) return false;
    return (
      drawer.open === true ||
      drawer.hasAttribute("open") ||
      drawer.getAttribute("aria-hidden") === "false" ||
      drawer.classList.contains("is-open") ||
      drawer.classList.contains("active") ||
      !drawer.classList.contains("pointer-events-none")
    );
  }

  /**
   * Open the native Concept cart drawer reliably.
   * 1) dispatch cart:refresh so the drawer re-renders its contents and opens itself
   * 2) as a safety net, call drawer.show() directly
   * 3) if it still didn't open shortly after, fall back to the /cart page
   */
  function openDrawerWithFallback() {
    const drawer = document.querySelector("cart-drawer");

    // No drawer on this page -> go straight to the cart page (always works)
    if (!drawer) {
      window.location.href = cartUrl();
      return;
    }

    // Ask the drawer to re-render + open
    document.dispatchEvent(
      new CustomEvent("cart:refresh", { detail: { open: true } })
    );

    // Safety net: directly call show() if the event path didn't open it
    setTimeout(() => {
      if (!isDrawerOpen(drawer) && typeof drawer.show === "function") {
        try {
          drawer.show();
        } catch (e) {
          /* ignore – handled by the final fallback below */
        }
      }
    }, 120);

    // Final fallback: if nothing opened, send the user to the cart page
    setTimeout(() => {
      if (!isDrawerOpen(drawer)) {
        window.location.href = cartUrl();
      }
    }, 550);
  }

  // -----------------------------
  // Split payments (spp2) helpers
  // -----------------------------
  function findSpp2Widget(form) {
    return (
      form
        .closest(".product, .product-info, .product__info-wrapper")
        ?.querySelector(".spp2__widget") || document.querySelector(".spp2__widget")
    );
  }

  function getCheckedPaymentOption(form) {
    const widget = findSpp2Widget(form);
    if (!widget) return null;
    return widget.querySelector('input[name="payment-option"]:checked');
  }

  function extractPercentFromWidget(widget) {
    const text = (widget?.textContent || "").replace(/\s+/g, " ").trim();
    const match =
      text.match(/paiement\s+initial\s*:\s*(\d+)\s*%/i) ||
      text.match(/(\d+)\s*%/);
    if (match && match[1]) return `${match[1]}%`;
    return "25%";
  }

  function getSplitPaymentProperty(form) {
    const widget = findSpp2Widget(form);
    if (!widget) return null;

    const checked = getCheckedPaymentOption(form);
    if (!checked) return null;

    // value="0" = paiement intégral
    if (String(checked.value) === "0") return null;

    const pct = extractPercentFromWidget(widget);
    return { "Paiement en plusieurs fois": pct };
  }

  // -----------------------------
  // Cart helpers
  // -----------------------------
  async function addToCart(form, variantId, quantity) {
    const splitProperty = getSplitPaymentProperty(form);

    const payload = {
      id: Number(variantId),
      quantity: Number(quantity),
      ...(splitProperty ? { properties: splitProperty } : {}),
    };

    const res = await fetch(`${theme.routes.cart_add_url}.js`, {
      ...theme.utils.fetchConfig("json"),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw data;
    return data;
  }

  // -----------------------------
  // UI helpers
  // -----------------------------
  function setLoading(button, isLoading) {
    if (!button) return;
    if (isLoading) {
      button.setAttribute("aria-busy", "true");
      button.disabled = true;
    } else {
      button.removeAttribute("aria-busy");
      button.disabled = false;
    }
  }

  function showError(form, err) {
    const box = form.querySelector(".product-form__error-message");
    if (!box) return;
    const msg =
      (err && (err.description || err.message)) ||
      "Impossible d’ajouter au panier. Réessaie.";
    box.textContent = msg;
    box.hidden = false;
  }

  function readRedirect(form) {
    // Accept multiple naming conventions to match your Liquid:
    // redirect_to / redirect-to / redirectTo / redirect
    const directAttr =
      form.getAttribute("data-redirect-to") ||
      form.getAttribute("data-redirect_to") ||
      form.getAttribute("data-redirect") ||
      form.getAttribute("data-redirectTo");

    const ds =
      form.dataset.redirectTo ||
      form.dataset.redirect_to ||
      form.dataset.redirect ||
      directAttr;

    return String(ds || "drawer").toLowerCase();
  }

  // -----------------------------
  // Main
  // -----------------------------
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.matches("[data-meta-buy-form]")) return;

    const variantId = form.querySelector('input[name="id"]')?.value;
    const qty = form.querySelector('input[name="quantity"]')?.value || "1";
    const redirect = readRedirect(form); // drawer | cart | checkout

    if (!variantId) return;

    const button = form.querySelector("[data-meta-buy-submit]");
    const errorBox = form.querySelector(".product-form__error-message");
    if (errorBox) errorBox.hidden = true;

    e.preventDefault();

    // 1) Add to cart (AJAX) + split property if selected.
    //    A failure here is the only thing that should stop the flow.
    try {
      setLoading(button, true);
      await addToCart(form, variantId, qty);
    } catch (err) {
      showError(form, err);
      console.error("[meta-buy-button] add-to-cart error:", err);
      setLoading(button, false);
      return;
    }

    // 2) Refresh theme cart state (header counter, drawer contents, etc.)
    //    NON-BLOCKING: if this throws, we must still open the drawer / redirect.
    try {
      const sections = getSectionsToBundle();
      if (sections.length) {
        const parsedState = await fetchCartSections(sections);
        publishCartUpdate(parsedState);
      }
    } catch (err) {
      console.warn("[meta-buy-button] cart refresh failed (non-blocking):", err);
    }

    setLoading(button, false);

    // 3) Redirect behavior
    if (redirect === "checkout") {
      window.location.href = "/checkout";
      return;
    }

    if (redirect === "cart") {
      window.location.href = cartUrl();
      return;
    }

    // default = drawer (with reliable fallback to the cart page)
    openDrawerWithFallback();
  });
})();
