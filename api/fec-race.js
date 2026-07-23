// GET /api/fec-race?state=AZ&district=01&office=H&cycle=2026
const {
  FEC_BASE,
    sendJson,
      sendError,
        handleOptions,
          fetchJson,
            requireEnv,
              getQuery,
              } = require('./_util');

              module.exports = async function handler(req, res) {
                if (handleOptions(req, res)) return;

                  try {
                      const state = getQuery(req, 'state');
                          const district = getQuery(req, 'district');
                              const office = getQuery(req, 'office', 'H');
                                  const cycle = getQuery(req, 'cycle', String(new Date().getFullYear()));

                                      if (!state) {
                                            return sendError(res, 400, 'Missing required query param: state');
                                                }

                                                    const apiKey = requireEnv('FEC_API_KEY');

                                                        const params = new URLSearchParams({
                                                              api_key: apiKey,
                                                                    state,
                                                                          office,
                                                                                cycle,
                                                                                      per_page: '20',
                                                                                            sort: 'name',
                                                                                                });

                                                                                                    if (district && office === 'H') {
                                                                                                          params.set('district', district);
                                                                                                              }
                                                                                                              
                                                                                                                  const url = FEC_BASE + '/candidates/?' + params.toString();
                                                                                                                      const data = await fetchJson(url);
                                                                                                                      
                                                                                                                          const candidates = (data.results || []).slice(0, 20).map(function (c) {
                                                                                                                                return {
                                                                                                                                        candidate_id: c.candidate_id,
                                                                                                                                                name: c.name,
                                                                                                                                                        party: c.party_full,
                                                                                                                                                                office: c.office_full,
                                                                                                                                                                        state: c.state,
                                                                                                                                                                                district: c.district,
                                                                                                                                                                                        incumbent_challenge: c.incumbent_challenge_full,
                                                                                                                                                                                                cycles: c.cycles,
                                                                                                                                                                                                      };
                                                                                                                                                                                                          });
                                                                                                                                                                                                          
                                                                                                                                                                                                              sendJson(res, 200, {
                                                                                                                                                                                                                    race: { state, district: district || null, office, cycle },
                                                                                                                                                                                                                          count: candidates.length,
                                                                                                                                                                                                                                candidates,
                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                      } catch (err) {
                                                                                                                                                                                                                                          sendError(res, err.status || 500, err.message || 'Unexpected error', { upstream: err.body });
                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                            };
                                                                                                                                                                                                                                            
