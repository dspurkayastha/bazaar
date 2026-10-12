/**
 * Small keyword classifier: product name (+ brand) -> ItemCategory. Instamart search results carry no category,
 * and the policy engine blocks/holds on category, so the order of the rules matters: risky categories first
 * (alcohol, tobacco, medicine, appliances, electronics), then everyday ones. Anything unrecognised is 'other'.
 */
import type { ItemCategory } from '../../core/types.js';

interface Rule {
  category: ItemCategory;
  re: RegExp;
  /** If this matches too, the rule does not apply (e.g. "ginger beer", "wine vinegar"). */
  not?: RegExp;
}

const RULES: Rule[] = [
  {
    category: 'alcohol',
    re: /\b(beers?|lager|stout|wines?|whisk(?:e)?y|vodka|rum|gin|brandy|tequila|champagne|scotch|bourbon|liquor|cider|breezer|kingfisher|bira|budweiser|old monk|blenders pride|imperial blue|royal stag)\b/i,
    not: /vinegar|non[- ]?alcoholic|alcohol[- ]?free|0\.0|ginger beer|root beer|cooking wine|rum extract|essence/i,
  },
  { category: 'tobacco', re: /\b(cigarettes?|cigars?|tobacco|gutka|gutkha|hookah|vapes?|e-?cig|bidi|beedi|snuff)\b/i },
  {
    category: 'pet',
    re: /\b(dog|puppy|cat|kitten|pet)\b[^,]{0,20}\b(food|treats?|kibble|litter|shampoo|biscuits?)\b|\b(pedigree|whiskas|drools|royal canin|me-?o|purepet|cat litter|kibble)\b/i,
  },
  {
    category: 'medicine',
    re: /\b(tablets?|capsules?|paracetamol|crocin|dolo|disprin|saridon|ointment|antacid|antiseptic|betadine|dettol antiseptic|cough (?:syrup|drops)|pain (?:relief|balm)|vicks|iodex|moov|volini|inhaler|ors|electral|pregnancy test|thermometer|bandage|band-?aid|cetirizine|ibuprofen|azithromycin|vitamin [a-z]\b|multivitamin|supplement|eno)\b/i,
    not: /dishwash|detergent|toilet|cleaner|freshener|soap/i,
  },
  {
    category: 'appliances',
    re: /\b(mixer|grinder|pressure cooker|rice cooker|kettle|toaster|electric iron|steam iron|iron box|air ?fryer|induction|microwave|oven|fan|heater|geyser|blender|juicer|vacuum cleaner|trimmer|hair dryer|straightener|water purifier|refrigerator|washing machine|sandwich maker|chopper|extension board)\b/i,
    not: /\b(fan[- ]?cake)\b/i,
  },
  {
    category: 'electronics',
    re: /\b(chargers?|usb|cables?|earphones?|earbuds?|headphones?|headset|power ?bank|bluetooth|speaker|smart ?watch|batter(?:y|ies)|pen ?drive|memory card|mouse|keyboard|adapter|adaptor|led (?:bulb|lamp|light)|torch|sim card|hdmi)\b/i,
    not: /\bcable (?:tie|ties)\b/i,
  },
  {
    category: 'baby',
    re: /\b(baby|infant|diapers?|nappy|nappies|cerelac|lactogen|nan pro|toddler)\b/i,
    not: /baby (?:corn|potato|spinach)/i,
  },
  {
    category: 'personal_care',
    re: /\b(shampoo|conditioner|soap|body ?wash|face ?wash|toothpaste|toothbrush|mouthwash|lotion|moisturi[sz]er|sunscreen|deodorant|deo|perfume|razor|shaving|sanitary|pads?|tampons?|hair oil|hair gel|face (?:cream|mask)|lip balm|talc|powder puff|hand ?wash|handwash|sanitizer|cotton buds|kajal|nail)\b/i,
    not: /dishwash|dish wash|detergent|laundry|toilet|surface|floor|pad ?lock/i,
  },
  {
    category: 'snacks',
    re: /\b(chips|crisps|namkeen|bhujia|biscuits?|cookies?|crackers?|chocolates?|candy|candies|toffee|wafers?|popcorn|cakes?|snacks?|mixture|kurkure|lays|bingo|puffs?|rusk|ice ?cream|brownie|muffin|protein bar|granola bar|energy bar|gummies|jelly|makhana|nachos|pringles|cheetos|oreo|bourbon biscuit|haldiram)\b/i,
  },
  {
    category: 'drinks',
    re: /\b(juices?|cola|soda|energy drink|cold drink|soft drink|lemonade|sparkling|tonic|kombucha|coconut water|mineral water|drinking water|packaged water|bisleri|aquafina|kinley|coke|coca[- ]cola|pepsi|sprite|fanta|thums up|limca|mountain dew|7 ?up|frooti|maaza|slice|appy|real fruit|paperboat|red bull|monster|gatorade|sting|cold coffee|iced tea|milkshake|shakes?|squash|sharbat|rooh afza|electrolyte drink|sherbet|water bottle)\b/i,
  },
  {
    category: 'meat',
    re: /\b(chicken|mutton|lamb|goat|fish|prawns?|shrimps?|crab|pork|beef|bacon|sausages?|salami|ham|keema|seafood|eggs?|rohu|katla|hilsa|ilish|pomfret|salmon|tuna|basa|surmai|bhetki|squid|turkey|meat|brisket|tangri|drumsticks?)\b/i,
    not: /egg(?:less)?\s*(?:mayo|mayonnaise|noodles|free)|eggless|fish oil|fish food|chicken (?:masala|stock|cube|seasoning|flavou?r)|masala|fishing|lamb'?s lettuce|goat milk|tuna (?:can|tin)(?=.*veg)/i,
  },
  {
    category: 'dairy',
    re: /\b(milk|curd|dahi|doi|yogh?urt|paneer|cheese|ghee|lassi|buttermilk|chaas|cream|khoa|mawa|kheer|condensed milk|whey|curds)\b|(?<!peanut |almond |cashew |cocoa |shea |body |nut )\bbutter\b/i,
    not: /coconut milk|soy(?:a)? milk|almond milk|oat milk|milk chocolate|milk powder tin|ice cream|face cream|hand cream|body cream|cold cream|shaving cream|cream biscuit|cream cracker|sour cream onion|ghee roast|peanut butter|milk bikis|milkshake|milk shake/i,
  },
  {
    category: 'produce',
    re: /\b(onions?|potato(?:es)?|tomato(?:es)?|spinach|palak|bananas?|apples?|mango(?:es)?|grapes|oranges?|lemons?|limes?|garlic|ginger|coriander|dhania|mint|pudina|capsicum|carrots?|cucumbers?|cabbage|cauliflower|brinjal|eggplant|okra|bhindi|mushrooms?|beans|peas|pumpkin|gourd|lauki|karela|beetroot|radish|papaya|pomegranate|guava|watermelon|melon|pineapple|kiwi|strawberr(?:y|ies)|berries|curry leaves|green chill(?:i|y|ies)|chill(?:i|y|ies) green|vegetables?|fruits?|salad|lettuce|broccoli|corn on the cob|sweet corn fresh|fresh herbs|sprouts|spring onion|leafy)\b/i,
    not: /ketchup|sauce|puree|paste|pickle|chips|powder|juice|jam|squash|essence|seasoning|masala|flavou?red|dried|dehydrated|canned|tinned|soup|oil|syrup|cake|biscuits?|bar\b|toothpaste|soap|shampoo|candle|wash|cleaner|freshener|tea\b|noodles|wafers|namkeen|chutney|vinegar/i,
  },
  {
    category: 'household',
    re: /\b(detergent|dish ?wash|dishwash(?:er)?|vim|surf excel|ariel|tide|harpic|lizol|colin|domex|phenyl|floor cleaner|toilet (?:cleaner|paper|roll)|tissue|napkins?|garbage bags?|trash bags?|bin liners?|mop|broom|scrub|sponge|aluminium foil|cling film|freshener|odonil|air freshener|mosquito|good ?knight|all ?out|hit spray|insect|agarbatti|incense|dhoop|camphor|candles?|matchbox|matches|bleach|fabric (?:softener|conditioner)|comfort|laundry|washing powder|bulb|zip ?lock|kitchen roll|cleaner|disinfectant|pest|cockroach)\b/i,
  },
  {
    category: 'grocery',
    re: /\b(atta|flour|maida|besan|suji|rava|semolina|rice|basmati|dal|dhal|lentils?|pulses|moong|chana|rajma|toor|urad|masoor|oil|sugar|jaggery|gur|salt|masala|spices?|turmeric|haldi|jeera|cumin|pepper|chilli powder|coriander powder|sauce|ketchup|jam|pickle|achar|noodles|pasta|macaroni|vermicelli|cereal|oats|muesli|cornflakes|honey|tea|coffee|peanut butter|dry fruits?|almonds?|cashews?|raisins|walnuts?|dates|pistachios?|poha|sooji|papad|bread|bun|pav|mayonnaise|vinegar|soup|tomato puree|tomato paste|baking|yeast|custard|essence|spread|chutney|sattu|ragi|millet|quinoa|tofu|soya chunks|coconut|coconut milk|soy milk|almond milk|oat milk)\b/i,
  },
];

export function classify(name: string, brand?: string): ItemCategory {
  const text = `${name} ${brand ?? ''}`.replace(/\s+/g, ' ').trim();
  if (text === '') return 'other';
  for (const rule of RULES) {
    if (rule.re.test(text) && !(rule.not && rule.not.test(text))) return rule.category;
  }
  return 'other';
}
