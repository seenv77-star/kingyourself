export default {
  async scheduled(_event, env) {
    await env.CONSULT_DB.prepare(
      "DELETE FROM consultations WHERE id IN (SELECT id FROM consultations WHERE expires_at <= ? ORDER BY expires_at LIMIT 500)"
    ).bind(new Date().toISOString()).run();
  }
};
