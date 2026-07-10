const header = document.querySelector(".site-header");

function updateHeader() {
  header?.classList.toggle("is-scrolled", window.scrollY > 18);
}

window.addEventListener("scroll", updateHeader, { passive: true });
updateHeader();

for (const button of document.querySelectorAll(".copy[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      const field = document.createElement("textarea");
      field.value = button.dataset.copy;
      field.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    const label = button.textContent;
    button.textContent = "Copied";
    button.classList.add("is-copied");
    window.setTimeout(() => {
      button.textContent = label;
      button.classList.remove("is-copied");
    }, 1600);
  });
}
