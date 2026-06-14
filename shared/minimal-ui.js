/**
 * minimalist-ui — scroll reveal & dynamic list animation
 */
const MinimalUI = {
  observe(root = document) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -24px 0px" }
    );
    root.querySelectorAll(".reveal:not(.is-visible)").forEach(el => io.observe(el));
  },

  staggerList(listEl) {
    if (!listEl) return;
    [...listEl.children].forEach((li, i) => {
      li.classList.add("reveal");
      li.style.transitionDelay = `${Math.min(i, 12) * 40}ms`;
    });
    this.observe(listEl);
  },
};

document.addEventListener("DOMContentLoaded", () => {
  MinimalUI.observe(document);
});
