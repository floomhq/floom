# Voice & Polish: LLM Refinement Prompt

You are refining an academic draft that did NOT pass the quality gate (score < 85%). Your task is to improve specific quality dimensions while preserving the academic content and citations.

## Quality Dimensions to Improve

### 1. Vocabulary Diversity (TTR)
Rotate overused words through synonyms:
- "mechanism" → process, pathway, driver, dynamic, factor
- "significant" → substantial, considerable, notable, marked
- "demonstrate" → shows, reveals, indicates, illustrates
- "facilitate" → enables, supports, helps, allows
- "comprehensive" → thorough, extensive, detailed
- "robust" → strong, reliable, solid, stable

**Rule**: No word should appear more than 3 times per 1000 words (except common function words).

### 2. Sentence Variety
Mix sentence lengths to create rhythm:
- Short declarative (8-12 words): "AI raises ethical dilemmas."
- Medium analytical (15-20 words): "A 2023 survey found 67% of clinicians reported inadequate consent protocols."
- Long complex (25-35 words): Only for synthesizing multiple ideas with proper subordination.

**Rule**: Never 3+ consecutive sentences of similar length.

### 3. Citation Placement
Citations must support SPECIFIC claims, not decorate paragraph endings.

**Wrong**: "Several approaches have been proposed {cite_001} {cite_002} {cite_003}."
**Right**: "Method A reduced errors by 34% {cite_001}, while Method B improved speed {cite_002}."

### 4. Claim Calibration
Replace overconfident language with calibrated hedging:
- "proves that" → "supports the finding that"
- "indisputable" → "strongly supported"
- "the only solution" → "a primary solution"
- "revolutionary" → "innovative"
- "always/never" → "consistently/rarely"
- "obviously" → "notably"

### 5. Thesis Restraint
The thesis should appear 2-3 times MAX (introduction + conclusion).
Replace mid-document thesis restatements:
- "As this paper argues..." → "As discussed..."
- "This study demonstrates..." → "The analysis reveals..."
- "We argue that..." → "The evidence suggests..."

### 6. Academic Tone
Remove advocacy language:
- "must be adopted" → "merits consideration"
- "we advocate" → "the evidence suggests"
- "demands that we" → "suggests that"
- "undeniably/unquestionably" → remove or use "notably"

## Process

1. Read the input text carefully
2. Identify the most impactful improvements (prioritize by quality score breakdown)
3. Apply refinements while preserving:
   - All {cite_XXX} placeholders intact
   - Section structure and headings
   - Tables and figures
   - Core arguments and evidence
4. Return the refined text

## Output Format

Return ONLY the refined text. Do not add commentary or explanations.
