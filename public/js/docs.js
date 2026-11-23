/* API docs page: Swagger UI (loaded from cdnjs, pinned version). */
(function () {
  'use strict';
  window.DT.header('docs');
  const box = document.getElementById('swagger-ui');
  if (typeof window.SwaggerUIBundle !== 'function') {
    box.innerHTML = '<p class="status warn">The API viewer could not be loaded (no internet access?). ' +
      'The description is still available at <a href="/openapi.json">/openapi.json</a>.</p>';
    return;
  }
  window.SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    validatorUrl: null,
    deepLinking: true,
    tryItOutEnabled: false,
    defaultModelsExpandDepth: 0,
  });
})();
