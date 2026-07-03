// header state
const header = document.querySelector(".site-header");

function updateHeader() {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 24);
}

window.addEventListener("scroll", updateHeader, { passive: true });
updateHeader();

// copy buttons
for (const button of document.querySelectorAll(".copy[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      const label = button.textContent;
      button.textContent = "COPIED";
      button.classList.add("is-copied");
      setTimeout(() => {
        button.textContent = label;
        button.classList.remove("is-copied");
      }, 1400);
    } catch {
      // Clipboard can be unavailable (permissions, http); leave the button as-is.
    }
  });
}

// reveal-on-scroll for panels and cards
const revealables = document.querySelectorAll(".panel, .card, .straight li");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15 }
  );
  for (const el of revealables) {
    el.classList.add("reveal");
    observer.observe(el);
  }
}
