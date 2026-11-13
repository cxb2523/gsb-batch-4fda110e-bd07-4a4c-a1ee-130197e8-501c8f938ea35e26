export type ExploreCategory = 'Science & Space' | 'Technology & Computing' | 'History & Civilization' | 'Nature & Society';

export interface ExploreTopic {
  slug: string;
  title: string;
  wikipediaTitle: string;
  description: string;
  intro: string;
  keywords: string[];
  relatedTopics: string[];
  category: ExploreCategory;
}

export const exploreTopics: ExploreTopic[] = [
  {
    slug: 'black-holes',
    title: 'Black Holes',
    wikipediaTitle: 'Black hole',
    description: 'Follow links from black holes into relativity, stellar evolution, gravitational waves, and cosmology.',
    intro: 'A black hole is a region of spacetime whose gravity is strong enough that nothing can escape beyond its event horizon. Its Wikipedia article sits at the intersection of general relativity, astronomy, and the physics of compact objects.',
    keywords: ['black holes', 'event horizon', 'general relativity', 'gravitational waves'],
    relatedTopics: ['general-relativity', 'gravitational-waves', 'astronomy', 'quantum-mechanics'],
    category: 'Science & Space',
  },
  {
    slug: 'artificial-intelligence',
    title: 'Artificial Intelligence',
    wikipediaTitle: 'Artificial intelligence',
    description: 'Trace connections among artificial intelligence, machine learning, robotics, and computing.',
    intro: 'Artificial intelligence brings together ideas about machine reasoning, learning, perception, and action. Exploring its linked articles reveals how the field draws on statistics, computer science, neuroscience, and engineering.',
    keywords: ['artificial intelligence', 'machine learning', 'robotics', 'computer science'],
    relatedTopics: ['machine-learning', 'neural-networks', 'computer-vision', 'robotics'],
    category: 'Technology & Computing',
  },
  {
    slug: 'machine-learning',
    title: 'Machine Learning',
    wikipediaTitle: 'Machine learning',
    description: 'Explore the links between machine learning, neural networks, statistics, and artificial intelligence.',
    intro: 'Machine learning studies methods that improve their performance through data or experience. Its connections lead from statistical learning and optimization to neural networks and practical fields such as computer vision.',
    keywords: ['machine learning', 'statistics', 'neural networks', 'artificial intelligence'],
    relatedTopics: ['artificial-intelligence', 'neural-networks', 'computer-vision', 'robotics'],
    category: 'Technology & Computing',
  },
  {
    slug: 'neural-networks',
    title: 'Neural Networks',
    wikipediaTitle: 'Artificial neural network',
    description: 'Follow neural networks into machine learning, neuroscience, and modern computing.',
    intro: 'Artificial neural networks are computing systems built from connected units whose parameters are adjusted during learning. The topic links engineering ideas with statistics and, historically, some inspiration from biological nervous systems.',
    keywords: ['neural networks', 'deep learning', 'machine learning', 'neuroscience'],
    relatedTopics: ['machine-learning', 'artificial-intelligence', 'neuroscience', 'computer-vision'],
    category: 'Technology & Computing',
  },
  {
    slug: 'computer-vision',
    title: 'Computer Vision',
    wikipediaTitle: 'Computer vision',
    description: 'Map the connections between computer vision, image processing, robotics, and machine learning.',
    intro: 'Computer vision develops methods for extracting information from images and video. Its links reach image processing, pattern recognition, machine learning, and robotic systems that act on visual input.',
    keywords: ['computer vision', 'image processing', 'machine learning', 'robotics'],
    relatedTopics: ['machine-learning', 'neural-networks', 'robotics', 'artificial-intelligence'],
    category: 'Technology & Computing',
  },
  {
    slug: 'robotics',
    title: 'Robotics',
    wikipediaTitle: 'Robotics',
    description: 'Explore how robotics connects control theory, artificial intelligence, engineering, and perception.',
    intro: 'Robotics combines the design and operation of machines with problems in control, sensing, and decision-making. Its article network crosses mechanical and electrical engineering as well as computer science.',
    keywords: ['robotics', 'control theory', 'artificial intelligence', 'engineering'],
    relatedTopics: ['artificial-intelligence', 'computer-vision', 'machine-learning', 'neural-networks'],
    category: 'Technology & Computing',
  },
  {
    slug: 'quantum-mechanics',
    title: 'Quantum Mechanics',
    wikipediaTitle: 'Quantum mechanics',
    description: 'Trace quantum mechanics through particle physics, quantum computing, and the foundations of physics.',
    intro: 'Quantum mechanics describes physical systems at atomic and subatomic scales. Its connections include quantum information, chemistry, particle physics, and questions about how measurement relates to physical states.',
    keywords: ['quantum mechanics', 'quantum physics', 'quantum computing', 'particle physics'],
    relatedTopics: ['quantum-computing', 'general-relativity', 'black-holes', 'astronomy'],
    category: 'Science & Space',
  },
  {
    slug: 'quantum-computing',
    title: 'Quantum Computing',
    wikipediaTitle: 'Quantum computing',
    description: 'Explore the overlap between quantum mechanics, information theory, and computing.',
    intro: 'Quantum computing uses quantum states to represent and process information. The subject links physical concepts such as superposition and entanglement with algorithms, information theory, and computer engineering.',
    keywords: ['quantum computing', 'quantum mechanics', 'quantum information', 'algorithms'],
    relatedTopics: ['quantum-mechanics', 'machine-learning', 'artificial-intelligence', 'neural-networks'],
    category: 'Technology & Computing',
  },
  {
    slug: 'general-relativity',
    title: 'General Relativity',
    wikipediaTitle: 'General relativity',
    description: 'Follow general relativity into black holes, gravitational waves, and cosmology.',
    intro: 'General relativity describes gravity through the geometry of spacetime and underpins modern models of compact objects and the universe at large scales. Its Wikipedia links connect mathematical physics with astronomical observation.',
    keywords: ['general relativity', 'spacetime', 'black holes', 'cosmology'],
    relatedTopics: ['black-holes', 'gravitational-waves', 'astronomy', 'quantum-mechanics'],
    category: 'Science & Space',
  },
  {
    slug: 'gravitational-waves',
    title: 'Gravitational Waves',
    wikipediaTitle: 'Gravitational wave',
    description: 'Explore gravitational waves through relativity, black holes, neutron stars, and astronomy.',
    intro: 'Gravitational waves are ripples in spacetime produced by accelerating masses. Their observation connects general relativity with the study of black-hole and neutron-star systems.',
    keywords: ['gravitational waves', 'general relativity', 'black holes', 'neutron stars'],
    relatedTopics: ['black-holes', 'general-relativity', 'astronomy', 'quantum-mechanics'],
    category: 'Science & Space',
  },
  {
    slug: 'evolution',
    title: 'Evolution',
    wikipediaTitle: 'Evolution',
    description: 'Trace evolution into genetics, ecology, natural selection, and the history of life.',
    intro: 'Biological evolution describes changes in heritable characteristics of populations over generations. Its connections span genetics, ecology, paleontology, and the mechanisms that shape biodiversity.',
    keywords: ['evolution', 'natural selection', 'genetics', 'biodiversity'],
    relatedTopics: ['neuroscience', 'consciousness', 'climate-change', 'ancient-egypt'],
    category: 'Nature & Society',
  },
  {
    slug: 'neuroscience',
    title: 'Neuroscience',
    wikipediaTitle: 'Neuroscience',
    description: 'Follow neuroscience across biology, cognition, consciousness, and neural networks.',
    intro: 'Neuroscience studies the nervous system, from cells and circuits to behavior and cognition. The subject connects biology with psychology, medicine, and computational models of learning.',
    keywords: ['neuroscience', 'brain', 'cognition', 'consciousness'],
    relatedTopics: ['consciousness', 'neural-networks', 'evolution', 'artificial-intelligence'],
    category: 'Nature & Society',
  },
  {
    slug: 'consciousness',
    title: 'Consciousness',
    wikipediaTitle: 'Consciousness',
    description: 'Explore how consciousness connects philosophy, neuroscience, and cognitive science.',
    intro: 'Consciousness refers to the states and processes associated with awareness and experience. Wikipedia’s coverage approaches it through philosophy, neuroscience, psychology, and cognitive science, each with distinct questions and methods.',
    keywords: ['consciousness', 'philosophy of mind', 'neuroscience', 'cognition'],
    relatedTopics: ['neuroscience', 'evolution', 'artificial-intelligence', 'neural-networks'],
    category: 'Nature & Society',
  },
  {
    slug: 'ancient-rome',
    title: 'Ancient Rome',
    wikipediaTitle: 'Ancient Rome',
    description: 'Follow Ancient Rome through its republic, empire, architecture, law, and Mediterranean neighbors.',
    intro: 'Ancient Rome’s history spans a city-state, a republic, and an empire whose institutions and infrastructure shaped much of the Mediterranean. Linked articles connect political history with law, architecture, and daily life.',
    keywords: ['Ancient Rome', 'Roman Republic', 'Roman Empire', 'Roman history'],
    relatedTopics: ['ancient-egypt', 'renaissance', 'world-war-ii', 'astronomy'],
    category: 'History & Civilization',
  },
  {
    slug: 'ancient-egypt',
    title: 'Ancient Egypt',
    wikipediaTitle: 'Ancient Egypt',
    description: 'Explore Ancient Egypt through archaeology, the Nile, pharaohs, and neighboring civilizations.',
    intro: 'Ancient Egyptian civilization developed along the Nile over thousands of years. Its article network reaches archaeology, religion, writing systems, political periods, and interactions with other Mediterranean societies.',
    keywords: ['Ancient Egypt', 'Egyptian civilization', 'archaeology', 'Nile'],
    relatedTopics: ['ancient-rome', 'renaissance', 'evolution', 'astronomy'],
    category: 'History & Civilization',
  },
  {
    slug: 'renaissance',
    title: 'Renaissance',
    wikipediaTitle: 'Renaissance',
    description: 'Trace the Renaissance through art, science, humanism, and the societies of early modern Europe.',
    intro: 'The Renaissance was a series of cultural and intellectual movements in Europe, with different timelines and forms across regions. Its connections include art, scholarship, technology, and the institutions that supported them.',
    keywords: ['Renaissance', 'Renaissance art', 'humanism', 'early modern Europe'],
    relatedTopics: ['ancient-rome', 'ancient-egypt', 'world-war-ii', 'astronomy'],
    category: 'History & Civilization',
  },
  {
    slug: 'world-war-ii',
    title: 'World War II',
    wikipediaTitle: 'World War II',
    description: 'Navigate World War II through its theaters, political history, technology, and aftermath.',
    intro: 'World War II was a global conflict from 1939 to 1945 involving many states and theaters of war. Its connected history includes political movements, military campaigns, civilian experiences, and postwar institutions.',
    keywords: ['World War II', 'Second World War', 'military history', '20th century'],
    relatedTopics: ['ancient-rome', 'renaissance', 'climate-change', 'space-exploration'],
    category: 'History & Civilization',
  },
  {
    slug: 'space-exploration',
    title: 'Space Exploration',
    wikipediaTitle: 'Space exploration',
    description: 'Follow space exploration across astronomy, spacecraft, the Moon, and the history of flight.',
    intro: 'Space exploration uses robotic and crewed missions to study regions beyond Earth. Its links span astronomy, aerospace engineering, planetary science, and the political history of spaceflight.',
    keywords: ['space exploration', 'spaceflight', 'astronomy', 'spacecraft'],
    relatedTopics: ['astronomy', 'black-holes', 'gravitational-waves', 'world-war-ii'],
    category: 'Science & Space',
  },
  {
    slug: 'astronomy',
    title: 'Astronomy',
    wikipediaTitle: 'Astronomy',
    description: 'Explore astronomy from stars and galaxies to black holes, cosmology, and space missions.',
    intro: 'Astronomy observes and explains objects and phenomena beyond Earth’s atmosphere. Its broad network connects stellar physics, planetary science, cosmology, and the instruments used to study the universe.',
    keywords: ['astronomy', 'stars', 'cosmology', 'space science'],
    relatedTopics: ['black-holes', 'general-relativity', 'gravitational-waves', 'space-exploration'],
    category: 'Science & Space',
  },
  {
    slug: 'climate-change',
    title: 'Climate Change',
    wikipediaTitle: 'Climate change',
    description: 'Trace climate change into climate science, ecosystems, energy, and public policy.',
    intro: 'Climate change describes long-term shifts in temperatures and weather patterns. Current discussion includes measured physical changes, contributing processes, effects on ecosystems, and possible responses.',
    keywords: ['climate change', 'climate science', 'greenhouse effect', 'ecosystems'],
    relatedTopics: ['evolution', 'world-war-ii', 'astronomy', 'artificial-intelligence'],
    category: 'Nature & Society',
  },
];

export function getExploreTopic(slug: string): ExploreTopic | undefined {
  return exploreTopics.find((topic) => topic.slug === slug);
}

export function validateExploreTopics(topics: ExploreTopic[] = exploreTopics): string[] {
  const issues: string[] = [];
  const slugs = new Set<string>();

  for (const topic of topics) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic.slug)) issues.push(`Invalid slug: ${topic.slug}`);
    if (slugs.has(topic.slug)) issues.push(`Duplicate slug: ${topic.slug}`);
    slugs.add(topic.slug);
    if (!topic.wikipediaTitle.trim()) issues.push(`Missing Wikipedia title for ${topic.slug}`);
    if (!topic.title.trim() || !topic.description.trim() || !topic.intro.trim()) issues.push(`Missing page content for ${topic.slug}`);
    if (!topic.keywords.length) issues.push(`Missing keywords for ${topic.slug}`);
  }

  for (const topic of topics) {
    for (const relatedSlug of topic.relatedTopics) {
      if (!slugs.has(relatedSlug)) issues.push(`Unknown related topic ${relatedSlug} in ${topic.slug}`);
    }
  }

  return issues;
}