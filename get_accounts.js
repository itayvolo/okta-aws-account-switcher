(() => {
  var radios = document.querySelectorAll('input[type="radio"]');
  var accounts = [];
  radios.forEach(radio => {
    try {
      const accountElement = radio.closest(".saml-account:not([id])");
      if (!accountElement) return;
      const nameElement = accountElement.querySelector(".saml-account-name");
      if (!nameElement) return;
      var account_name = nameElement.innerText;
      var valueParts = radio.value.split('/');
      var role_name = valueParts.length > 1 ? valueParts[1] : valueParts[0];
      accounts.push({"name": account_name, "role": role_name});
    } catch (e) {
      console.error('Error parsing account:', e);
    }
  });
  return accounts;
})();