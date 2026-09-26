-- Reusable configuration and demo data. Safe to re-run.
INSERT OR REPLACE INTO agent_config (role, model, fallback_model, reasoning, max_tokens, timeout_ms) VALUES
 ('extractor',     '@cf/moonshotai/kimi-k2.6',              '@cf/zai-org/glm-5.3',                     'none', 3000, 45000),
 ('certification', '@cf/deepseek-ai/deepseek-v4-pro-0813',  '@cf/deepseek-ai/deepseek-v4-flash-0731',  'high', 3000, 60000),
 ('quantitative',  '@cf/deepseek-ai/deepseek-v4-pro-0813',  '@cf/deepseek-ai/deepseek-v4-flash-0731',  'high', 3000, 60000),
 ('sourcing',      '@cf/moonshotai/kimi-k2.6',              '@cf/zai-org/glm-5.3',                     'high', 3000, 60000),
 ('action',        '@cf/moonshotai/kimi-k2.6',              '@cf/deepseek-ai/deepseek-v4-flash-0731',  'none', 1500, 45000);

INSERT OR REPLACE INTO official_sources (id, name, domain, claim_types, keywords, lookup_url_pattern, independent, notes) VALUES
 ('cfi',        'Cruelty Free International (Leaping Bunny)', 'crueltyfreeinternational.org', 'certification', 'cruelty,crueldade,leaping bunny,animal,testad,tested on animals,cruelty free international', 'https://www.crueltyfreeinternational.org/approved-brands/listing/{slug}/', 1, 'Brand-level approval listing'),
 ('vegansoc',   'The Vegan Society trademark',                'vegansociety.com',             'certification,sourcing', 'vegan,vegano,vegana', 'https://www.vegansociety.com/search/site/{brand}', 1, 'Registered vegan trademark products'),
 ('ecobeauty',  'EcoBeautyScore Consortium',                  'ecobeautyscore.com',           'certification,quantitative', 'ecobeautyscore,eco beauty score,impacto ambiental,environmental impact', 'https://www.ecobeautyscore.com/', 1, 'Industry scoring method; consortium of cosmetics companies'),
 ('fairtrade',  'Fairtrade International',                    'fairtrade.net',                'sourcing,certification', 'fairtrade,fair trade,comércio justo,comercio justo', 'https://www.fairtrade.net/', 1, NULL),
 ('rspo',       'Roundtable on Sustainable Palm Oil',         'rspo.org',                     'sourcing,certification', 'palm,palma,rspo', 'https://rspo.org/', 1, NULL),
 ('fsc',        'Forest Stewardship Council',                 'fsc.org',                      'certification,sourcing', 'fsc,forest,floresta,papel,paper,cartão,cardboard', 'https://fsc.org/en', 1, NULL),
 ('cosmos',     'COSMOS (organic/natural cosmetics standard)', 'cosmos-standard.org',         'certification', 'cosmos,organic,orgânico,biológico,ecocert', 'https://www.cosmos-standard.org/', 1, NULL),
 ('lorealplanet','L''Oréal Groupe commitments (brand owner, self-declared)', 'loreal.com',    'quantitative,sourcing,generic', 'reciclad,recycled,recicláv,recyclable,refill,recarga,plástico,plastic,carbon,carbono,water,água,natural,biodegrad', 'https://www.loreal.com/en/commitments-and-responsibilities/for-the-planet/', 0, 'Parent group of Garnier and YSL Beauty; not independent');

INSERT OR REPLACE INTO demo_cases (id, title, input_url, expected, sort) VALUES
 ('garnier-pt', 'Garnier Portugal homepage', 'https://www.garnier.pt/', 'Finds at least one sustainability claim on the site (follows links if homepage has none); every quote verified; run ends done or incomplete with reason', 1),
 ('garnier-uk', 'Garnier UK — cruelty free', 'https://www.garnier.co.uk/within-garnier', 'BACKED for brand approval via Cruelty Free International listing', 2),
 ('ysl-libre',  'YSL Libre refill', 'https://www.yslbeauty.co.uk/fragrances/fragrances-for-her/libre/libre-eau-de-parfum/WW-50424YSL.html?dwvar_WW-50424YSL_size=50+ml', 'NOT_PUBLICLY_VERIFIABLE: baseline found, component data missing', 3),
 ('lush',       'Lush — ethically sourced', 'https://www.lush.com/au/en/a/how-make-bath-bombs', 'VAGUE for the broad heading', 4);
