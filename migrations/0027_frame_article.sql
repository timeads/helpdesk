-- One-time content update: "How to Build Your Own Tufting Frame" rewritten from the book (pages 36-47),
-- with photos on Shopify Files. The earlier text is kept as a version (Versions menu in the editor).
-- It is left unpublished in the desk: press "Publish to store" to send it.
INSERT INTO kb_versions (article_id, title, topic_id, body_html, description, status, reason)
  SELECT id, title, topic_id, body_html, description, status, 'Before the rewrite from the book'
  FROM kb_articles WHERE blog_handle = 'knowledge-base' AND shopify_handle = 'how-to-build-your-own-tufting-frame';

UPDATE kb_articles SET
  body_html = '<p>Building your own tufting frame saves money and gets you exactly the size you need. This guide covers the two frames from our book, <a href="/products/tuft-the-world-an-illustrated-manual-to-tufting-gorgeous-rugs-decor-and-more"><em>Tuft the World: An Illustrated Manual to Tufting Gorgeous Rugs, Decor, and More</em></a> (pages 36–47): a <strong>tabletop frame</strong> that clamps to a worktable, and a <strong>freestanding frame</strong> for bigger rugs.</p>
<table>
<thead><tr><th></th><th>Tabletop frame</th><th>Freestanding frame</th></tr></thead>
<tbody>
<tr><th>Finished size</th><td>30" × 30" (76 × 76 cm)</td><td>72" wide × 66" tall (183 × 168 cm)</td></tr>
<tr><th>Lumber</th><td>1 × 4 pine</td><td>2 × 4 pine</td></tr>
<tr><th>Holds it steady</th><td>Two clamps on a table</td><td>Braced legs, sandbags or wall braces</td></tr>
<tr><th>Best for</th><td>Beginners, small rugs, wall hangings, small spaces</td><td>Large rugs and bigger cuts of cloth</td></tr>
<tr><th>Cloth it fits</th><td>1 yard of Primary Tufting Cloth makes 4 pieces</td><td>2 yards of Primary Tufting Cloth makes 2 pieces</td></tr>
</tbody>
</table>
<p>Both frames use the same tools: a drill or impact driver, a hammer or pneumatic stapler, wood glue and work gloves. If you''d rather skip the build, our <a href="/products/instant-tufting-frame">Instant Tufting Frame</a> is the same 30" × 30" size as the tabletop frame.</p>

<h2>What Size Frame Should I Build?</h2>
<p>Build your frame around the cloth you''ll use most. The sizes below are based on our <a href="/products/primary-tufting-cloth-by-the-yard">Primary Tufting Cloth</a>, which is 157" (4 m) wide. Stick to one of these frame sizes and you''ll have little to no waste.</p>
<table>
<thead><tr><th>Frame size (inches)</th><th>Frame size (cm)</th><th>Pieces you can tuft</th></tr></thead>
<tbody>
<tr><th colspan="3">1 yard of cloth: 36" × 157" (91 cm × 4 m)</th></tr>
<tr><td><strong>30 × 30</strong> (tabletop frame, Instant Tufting Frame)</td><td>76 × 76</td><td><strong>4</strong></td></tr>
<tr><td><strong>48 × 30</strong></td><td>122 × 76</td><td><strong>3</strong></td></tr>
<tr><th colspan="3">2 yards of cloth: 72" × 157" (182 cm × 4 m)</th></tr>
<tr><td><strong>66 × 30</strong></td><td>167 × 76</td><td><strong>4</strong></td></tr>
<tr><td><strong>66 × 44</strong></td><td>167 × 111</td><td><strong>3</strong></td></tr>
<tr><td><strong>66 × 72</strong> (freestanding frame)</td><td>167 × 183</td><td><strong>2</strong></td></tr>
<tr><th colspan="3">3 yards of cloth: 108" × 157" (274 cm × 4 m)</th></tr>
<tr><td><strong>96 × 44</strong></td><td>244 × 111</td><td><strong>3</strong></td></tr>
<tr><td><strong>96 × 72</strong></td><td>244 × 183</td><td><strong>2</strong></td></tr>
</tbody>
</table>

<h2>How to Build a Tabletop Tufting Frame</h2>
<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-tufting-frame-finished.jpg?v=1791112442" alt="Finished DIY tabletop tufting frame clamped to a worktable" width="582" height="480"><figcaption>The finished tabletop frame, with the yarn holder and feeder on the right side for a right-handed tufter.</figcaption></figure>
<p><strong>Finished size:</strong> 30" × 30" (76.2 × 76.2 cm)</p>

<h3>Materials</h3>
<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-tufting-frame-materials.jpg?v=1791112442" alt="Materials for a tabletop tufting frame laid out: pine boards, carpet tack, screws, drill, stapler, clamps and dowels" width="408" height="288"></figure>
<table>
<thead><tr><th>Qty</th><th>Item</th><th>Size</th></tr></thead>
<tbody>
<tr><th colspan="3">Lumber (1 × 4 pine)</th></tr>
<tr><td>1</td><td>Base board</td><td>1 × 4 × 34" (2.5 × 10.2 × 86.4 cm)</td></tr>
<tr><td>2</td><td>Side boards</td><td>1 × 4 × 30" (2.5 × 10.2 × 76.2 cm)</td></tr>
<tr><td>1</td><td>Top board</td><td>1 × 4 × 29¼" (2.5 × 10.2 × 74.3 cm)</td></tr>
<tr><td>2</td><td>Yarn holder and feeder boards</td><td>1 × 4 × 12" (2.5 × 10.2 × 30.5 cm)</td></tr>
<tr><th colspan="3">Hardware</th></tr>
<tr><td>4</td><td>Carpet tack strips</td><td>30" (76.2 cm) each</td></tr>
<tr><td>1 box</td><td>Wood screws</td><td>2½" (6.4 cm)</td></tr>
<tr><td>1 box</td><td>Nails or staples</td><td>1" (2.5 cm)</td></tr>
<tr><td>2</td><td>Eye screws</td><td></td></tr>
<tr><td>2</td><td>Dowel rods</td><td>6" long, ½" diameter (15.2 × 1.2 cm)</td></tr>
<tr><td>2</td><td>Clamps</td><td>Sized for your worktable</td></tr>
<tr><th colspan="3">Tools</th></tr>
<tr><td></td><td>Screwdriver, electric drill or impact driver</td><td></td></tr>
<tr><td></td><td>½" (1.2 cm) drill bit</td><td>Forstner preferred, any bit works</td></tr>
<tr><td></td><td>Hammer or pneumatic stapler, wood glue, work gloves</td><td></td></tr>
</tbody>
</table>

<h3>Instructions</h3>
<ol>
<li><strong>Attach the sides to the base.</strong> Lay the 34" base board down and place the two 30" side boards on it, 2" (5 cm) in from each end. Screw them on. The ends that stick out are where the clamps will hold the frame to the table. Predrill your holes so the boards don''t split.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-frame-step-1-attach-sides.jpg?v=1791112442" alt="Side boards placed on the base board of a tabletop tufting frame" width="267" height="226"></figure></li>
<li><strong>Add the top board.</strong> Flip the frame over and screw the 29¼" top board across the two sides.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-frame-step-2-top-board.jpg?v=1791112442" alt="Screwing the top board onto the sides of a tabletop tufting frame" width="267" height="226"></figure></li>
<li><strong>Glue on the carpet tack.</strong> Lay the tack out to match the boards. The top and sides are covered completely. On the base, the tack runs only between the sides, not on the ends that stick out. Run a thin line of glue along the narrow edge of each board and along the smooth side of the tack, then press the tack on with every tack pointing away from the center.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-frame-step-3-carpet-tack.jpg?v=1791112442" alt="Laying carpet tack strip along the edge of a tabletop tufting frame" width="268" height="226"></figure></li>
<li><strong>Nail or staple the tack.</strong> Use 4 or 5 nails or staples per piece.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-frame-step-4-staple-tack.jpg?v=1791112442" alt="Stapling carpet tack strip to a tufting frame with a pneumatic stapler" width="720" height="388"></figure></li>
<li><strong>Mark the yarn holder and feeder.</strong> On one 12" board (the yarn holder), make two marks 3" (7.6 cm) in from each end, centered on the width of the board. The other 12" board is the yarn feeder, which sits above the holder. Mark the edge of the feeder directly above each holder mark and twist in the two eye screws there.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-frame-step-5-eye-screws.jpg?v=1791112442" alt="Eye screw twisted into the yarn feeder board" width="302" height="229"></figure></li>
<li><strong>Drill the dowel holes.</strong> With the ½" bit, drill a hole at each mark on the holder board. Don''t drill all the way through. These holes hold the dowel rods.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-frame-step-6-drill-dowel-holes.jpg?v=1791112442" alt="Drilling a half-inch dowel hole into the yarn holder board with a Forstner bit" width="408" height="248"></figure></li>
<li><strong>Attach the holder and feeder.</strong> They go on the side of your dominant hand: the right side if you''re right-handed. Mark the side of the frame 4" (10.2 cm) from the top for the feeder and 4" from the bottom for the holder. Predrill two holes in the frame for each board, drill matching holes into the ends of the boards, and screw them on. L brackets work too if that''s easier.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/tabletop-frame-step-7-attach-holder.jpg?v=1791112442" alt="Screwing the yarn holder board to the side of a tabletop tufting frame" width="304" height="227"></figure></li>
<li><strong>Finish up.</strong> Push the dowel rods into their holes and clamp the frame to your table.</li>
</ol>
<p class="kb-tip"><strong>Tip: which way should the tack point?</strong> The tacks on carpet strip lean to one side, like a row of eyelashes. For the cloth to grip, they must point away from the center of the frame: up on the top board, down on the bottom, right on the right side and left on the left.</p>

<h2>How to Build a Freestanding Tufting Frame</h2>
<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-tufting-frame-finished.jpg?v=1791112442" alt="Completed freestanding tufting frame with yarn holder, wall braces and sandbags on the feet" width="692" height="651"><figcaption>A completed freestanding frame with a yarn holder, wall braces, and sandbags over the feet.</figcaption></figure>
<p><strong>Finished size:</strong> 72" wide × 66" tall (183 × 168 cm)</p>
<p>Larger frames are built from thicker 2 × 4 lumber because they carry more weight and take more pressure. A long, narrow board flexes one way but not the other, so this frame has the <strong>wide face of each board facing forward</strong>, not the edge. That keeps it from bending when you stretch your cloth tight. It stands on braced legs and should be held in place with sandbags, screws or wall braces, because tufting pushes hard against the frame.</p>

<h3>Materials</h3>
<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-tufting-frame-materials.jpg?v=1791112442" alt="Materials for a freestanding tufting frame laid out: 2x4 lumber, carpet tack, L brackets, screws and tools" width="504" height="723"></figure>
<table>
<thead><tr><th>Qty</th><th>Item</th><th>Size</th></tr></thead>
<tbody>
<tr><th colspan="3">Lumber (2 × 4 pine)</th></tr>
<tr><td>2</td><td>Frame sides (vertical)</td><td>2 × 4 × 66" (5 × 10 × 168 cm)</td></tr>
<tr><td>2</td><td>Frame top and base (horizontal)</td><td>2 × 4 × 72" (5 × 10 × 183 cm)</td></tr>
<tr><td>4</td><td>Legs and feet</td><td>2 × 4 × 24" (5 × 10 × 61 cm)</td></tr>
<tr><td>4</td><td>Leg supports, 45° miter cut</td><td>2 × 4 × 11" (5 × 10 × 28 cm)</td></tr>
<tr><td>3</td><td>Yarn holder and feeder</td><td>2 × 4 × 16" (5 × 10 × 41 cm)</td></tr>
<tr><th colspan="3">Hardware</th></tr>
<tr><td>276"</td><td>Carpet tack strip (701 cm in total)</td><td></td></tr>
<tr><td>1 box</td><td>Wood screws</td><td>5" (13 cm)</td></tr>
<tr><td>1 box</td><td>Wood screws</td><td>3" (7.5 cm)</td></tr>
<tr><td>4</td><td>L brackets</td><td></td></tr>
<tr><td>1 box</td><td>Nails or staples</td><td>1" (2.5 cm)</td></tr>
<tr><td>2</td><td>Eye screws</td><td></td></tr>
<tr><td>2</td><td>Dowel rods</td><td>6" long, ½" diameter (15.2 × 1.2 cm)</td></tr>
<tr><td>2</td><td>Sandbags</td><td>About 20 lb (9 kg) each</td></tr>
<tr><th colspan="3">Tools</th></tr>
<tr><td></td><td>Screwdriver, electric drill or impact driver</td><td></td></tr>
<tr><td></td><td>½" round drill bit</td><td>Forstner preferred, any bit works</td></tr>
<tr><td></td><td>Hammer or pneumatic stapler, wood glue, work gloves</td><td></td></tr>
</tbody>
</table>

<h3>Instructions</h3>
<ol>
<li><strong>Lay out the frame.</strong> On the floor or a large table, sort the boards by size. The two 66" boards are the vertical sides; the two 72" boards are the top and base.</li>
<li><strong>Screw the rectangle together</strong> with the 5" wood screws.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-1-screw-rectangle.jpg?v=1791112442" alt="Screwing 2x4 boards together into the rectangle of a freestanding tufting frame" width="720" height="455"></figure></li>
<li><strong>Add an L bracket in each corner</strong> with the 3" screws for extra stability.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-2-l-brackets.jpg?v=1791112442" alt="L bracket screwed into the corner of a freestanding tufting frame" width="269" height="244"></figure></li>
<li><strong>Glue on the carpet tack.</strong> The tack goes on the front edge of the wide face of the boards, with every tack angled away from the center. Run a thin line of glue along the edge of each board and along the smooth side of the tack. The tack covers the top and bottom boards end to end, and the sides from the top down to the base, stopping short of the legs.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-3-glue-tack.jpg?v=1791112442" alt="Running a line of wood glue along the edge of a frame board for the carpet tack" width="268" height="282"></figure></li>
<li><strong>Nail or staple the tack</strong> every 4–5" (10–12 cm).<div class="kb-gallery"><figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-4-staple-tack.jpg?v=1791112442" alt="Stapling carpet tack strip to a 2x4 frame board" width="720" height="479"></figure><figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-5-tack-direction.jpg?v=1791112442" alt="Close-up of carpet tack teeth angled away from the center of the tufting frame" width="720" height="480"><figcaption>Close-up: the tacks lean away from the center.</figcaption></figure></div></li>
<li><strong>Build the legs.</strong> For each leg, lay two 24" boards perpendicular to each other (one is the leg, one is the foot) and add two mitered 11" supports. Screw the long pieces together with 3" screws, then screw in the mitered supports to tie them together. Make two.<div class="kb-gallery"><figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-6-lay-out-legs.jpg?v=1791112442" alt="Laying out the leg, foot and mitered brace pieces for a freestanding tufting frame" width="287" height="207"></figure><figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-7-assemble-legs.jpg?v=1791112442" alt="Screwing a mitered brace into a tufting frame leg" width="265" height="171"></figure></div></li>
<li><strong>Attach the legs.</strong> Turn the frame over so you''re working on the back (the side without carpet tack). Measure 12" (30.5 cm) up from the bottom on both sides and screw the legs on with 3" screws. Keep each leg parallel to the frame so its foot sits flat on the floor.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-8-attach-legs.jpg?v=1791112442" alt="Leg attached to the back of a freestanding tufting frame" width="265" height="171"></figure></li>
<li><strong>Make the yarn holder.</strong> It goes on the same side as the feeder, on your dominant-hand side. Mark the holder board 3" (7.5 cm) in from each end, centered on its width. With the ½" bit, drill a hole at each mark without going through, then push in the dowel rods.</li>
<li><strong>Attach the feeder</strong> to the top back of the frame. Line the eye screws up with the dowels on the yarn holder below.<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-9-yarn-feeder.jpg?v=1791112442" alt="Attaching the yarn feeder board with eye screws to the top of a freestanding tufting frame" width="683" height="478"></figure></li>
<li><strong>Secure the frame</strong> to the floor with weights or screws. One sandbag over each foot works well; about 20 lb (9 kg) each is enough. Hardware and garden stores sell them.</li>
</ol>

<h3>Test the Strength, and Add Wall Braces if Needed</h3>
<p>Once it''s built, take two steps back and lean against the frame. It should hold your body weight without flexing much. If it bends or strains, add wall braces: two boards 14½" (36.8 cm) long (half the length of a foot plus the width of the frame), screwed to the top right and top left of the frame, sticking straight out the back so they rest against the wall. Now the feet support the bottom and the wall supports the top, so pressure on the frame goes into the wall instead of bending the frame. If you have thick baseboards or molding, make the braces an inch or so longer than the feet.</p>
<figure><img src="https://cdn.shopify.com/s/files/1/0025/7530/2719/files/freestanding-frame-step-10-wall-brace.jpg?v=1791112442" alt="Screwing a wall brace board to the top of a freestanding tufting frame" width="662" height="480"></figure>
<p class="kb-tip"><strong>Tip: feed yarn from above.</strong> Whether your yarn holder is built into the frame or stands on its own, put feeder loops near the top of the frame. Yarn that feeds down from above flows to the machine more smoothly and doesn''t tangle, and the holder keeps cones from tipping over or rolling away.</p>

<h2>Going Bigger</h2>
<p>For frames longer than the freestanding frame, the beams need even more strength. Depending on your tools, there are three main options:</p>
<ul>
<li><strong>Doubled-up 2 × 6 lumber:</strong> Use doubled 2 × 6 boards for the longest lengths. If the frame is longer than standard board lengths, stagger the seams so the joints don''t line up.</li>
<li><strong>Steel box tube:</strong> Very rigid, but needs welding or a metal shop. For reference, our 10 × 13 ft CNC frame is made from 4 × 6 box tube with a ¼" wall, which is more than most frames need.</li>
<li><strong>Aluminum box tube (around 4 × 6):</strong> Much lighter and easier to work with than steel, and still stiff.</li>
</ul>
<p>Professional tufting studios such as Kramis and Dovecot have shared videos of their frames, and those are worth a look for ideas. If you''d like help designing a specific frame, contact us. We offer frame design consultations for a small fee.</p>

<h2>Replacing Damaged Tack Strips</h2>
<p>If the tack strips on your frame get chipped or bent, you don''t need a new frame. Standard carpet tack strip is sold at home-improvement stores such as Home Depot. Pull off the damaged strips and attach new ones the same way, with glue and nails or staples, tacks pointing away from the center. Choose strip with pre-installed nails and avoid peel-and-stick versions.</p>

<h2>Learn More in the Book</h2>
<p>These projects come from <a href="/products/tuft-the-world-an-illustrated-manual-to-tufting-gorgeous-rugs-decor-and-more"><em>Tuft the World: An Illustrated Manual to Tufting Gorgeous Rugs, Decor, and More</em></a>, pages 36–47. The book has much more on setting up your tufting space, plus step-by-step projects. It''s available on our website and from all major booksellers.</p>',
  body_text = 'Building your own tufting frame saves money and gets you exactly the size you need. This guide covers the two frames from our book, Tuft the World: An Illustrated Manual to Tufting Gorgeous Rugs, Decor, and More (pages 36–47): a tabletop frame that clamps to a worktable, and a freestanding frame for bigger rugs.

Tabletop frameFreestanding frame

Finished size30" × 30" (76 × 76 cm)72" wide × 66" tall (183 × 168 cm)

Lumber1 × 4 pine2 × 4 pine

Holds it steadyTwo clamps on a tableBraced legs, sandbags or wall braces

Best forBeginners, small rugs, wall hangings, small spacesLarge rugs and bigger cuts of cloth

Cloth it fits1 yard of Primary Tufting Cloth makes 4 pieces2 yards of Primary Tufting Cloth makes 2 pieces

Both frames use the same tools: a drill or impact driver, a hammer or pneumatic stapler, wood glue and work gloves. If you''d rather skip the build, our Instant Tufting Frame is the same 30" × 30" size as the tabletop frame.

What Size Frame Should I Build?

Build your frame around the cloth you''ll use most. The sizes below are based on our Primary Tufting Cloth, which is 157" (4 m) wide. Stick to one of these frame sizes and you''ll have little to no waste.

Frame size (inches)Frame size (cm)Pieces you can tuft

1 yard of cloth: 36" × 157" (91 cm × 4 m)

30 × 30 (tabletop frame, Instant Tufting Frame)76 × 764

48 × 30122 × 763

2 yards of cloth: 72" × 157" (182 cm × 4 m)

66 × 30167 × 764

66 × 44167 × 1113

66 × 72 (freestanding frame)167 × 1832

3 yards of cloth: 108" × 157" (274 cm × 4 m)

96 × 44244 × 1113

96 × 72244 × 1832

How to Build a Tabletop Tufting Frame

The finished tabletop frame, with the yarn holder and feeder on the right side for a right-handed tufter.
Finished size: 30" × 30" (76.2 × 76.2 cm)

Materials

QtyItemSize

Lumber (1 × 4 pine)

1Base board1 × 4 × 34" (2.5 × 10.2 × 86.4 cm)

2Side boards1 × 4 × 30" (2.5 × 10.2 × 76.2 cm)

1Top board1 × 4 × 29¼" (2.5 × 10.2 × 74.3 cm)

2Yarn holder and feeder boards1 × 4 × 12" (2.5 × 10.2 × 30.5 cm)

Hardware

4Carpet tack strips30" (76.2 cm) each

1 boxWood screws2½" (6.4 cm)

1 boxNails or staples1" (2.5 cm)

2Eye screws

2Dowel rods6" long, ½" diameter (15.2 × 1.2 cm)

2ClampsSized for your worktable

Tools

Screwdriver, electric drill or impact driver

½" (1.2 cm) drill bitForstner preferred, any bit works

Hammer or pneumatic stapler, wood glue, work gloves

Instructions

Attach the sides to the base. Lay the 34" base board down and place the two 30" side boards on it, 2" (5 cm) in from each end. Screw them on. The ends that stick out are where the clamps will hold the frame to the table. Predrill your holes so the boards don''t split.

Add the top board. Flip the frame over and screw the 29¼" top board across the two sides.

Glue on the carpet tack. Lay the tack out to match the boards. The top and sides are covered completely. On the base, the tack runs only between the sides, not on the ends that stick out. Run a thin line of glue along the narrow edge of each board and along the smooth side of the tack, then press the tack on with every tack pointing away from the center.

Nail or staple the tack. Use 4 or 5 nails or staples per piece.

Mark the yarn holder and feeder. On one 12" board (the yarn holder), make two marks 3" (7.6 cm) in from each end, centered on the width of the board. The other 12" board is the yarn feeder, which sits above the holder. Mark the edge of the feeder directly above each holder mark and twist in the two eye screws there.

Drill the dowel holes. With the ½" bit, drill a hole at each mark on the holder board. Don''t drill all the way through. These holes hold the dowel rods.

Attach the holder and feeder. They go on the side of your dominant hand: the right side if you''re right-handed. Mark the side of the frame 4" (10.2 cm) from the top for the feeder and 4" from the bottom for the holder. Predrill two holes in the frame for each board, drill matching holes into the ends of the boards, and screw them on. L brackets work too if that''s easier.

Finish up. Push the dowel rods into their holes and clamp the frame to your table.

Tip: which way should the tack point? The tacks on carpet strip lean to one side, like a row of eyelashes. For the cloth to grip, they must point away from the center of the frame: up on the top board, down on the bottom, right on the right side and left on the left.

How to Build a Freestanding Tufting Frame

A completed freestanding frame with a yarn holder, wall braces, and sandbags over the feet.
Finished size: 72" wide × 66" tall (183 × 168 cm)

Larger frames are built from thicker 2 × 4 lumber because they carry more weight and take more pressure. A long, narrow board flexes one way but not the other, so this frame has the wide face of each board facing forward, not the edge. That keeps it from bending when you stretch your cloth tight. It stands on braced legs and should be held in place with sandbags, screws or wall braces, because tufting pushes hard against the frame.

Materials

QtyItemSize

Lumber (2 × 4 pine)

2Frame sides (vertical)2 × 4 × 66" (5 × 10 × 168 cm)

2Frame top and base (horizontal)2 × 4 × 72" (5 × 10 × 183 cm)

4Legs and feet2 × 4 × 24" (5 × 10 × 61 cm)

4Leg supports, 45° miter cut2 × 4 × 11" (5 × 10 × 28 cm)

3Yarn holder and feeder2 × 4 × 16" (5 × 10 × 41 cm)

Hardware

276"Carpet tack strip (701 cm in total)

1 boxWood screws5" (13 cm)

1 boxWood screws3" (7.5 cm)

4L brackets

1 boxNails or staples1" (2.5 cm)

2Eye screws

2Dowel rods6" long, ½" diameter (15.2 × 1.2 cm)

2SandbagsAbout 20 lb (9 kg) each

Tools

Screwdriver, electric drill or impact driver

½" round drill bitForstner preferred, any bit works

Hammer or pneumatic stapler, wood glue, work gloves

Instructions

Lay out the frame. On the floor or a large table, sort the boards by size. The two 66" boards are the vertical sides; the two 72" boards are the top and base.

Screw the rectangle together with the 5" wood screws.

Add an L bracket in each corner with the 3" screws for extra stability.

Glue on the carpet tack. The tack goes on the front edge of the wide face of the boards, with every tack angled away from the center. Run a thin line of glue along the edge of each board and along the smooth side of the tack. The tack covers the top and bottom boards end to end, and the sides from the top down to the base, stopping short of the legs.

Nail or staple the tack every 4–5" (10–12 cm).Close-up: the tacks lean away from the center.

Build the legs. For each leg, lay two 24" boards perpendicular to each other (one is the leg, one is the foot) and add two mitered 11" supports. Screw the long pieces together with 3" screws, then screw in the mitered supports to tie them together. Make two.

Attach the legs. Turn the frame over so you''re working on the back (the side without carpet tack). Measure 12" (30.5 cm) up from the bottom on both sides and screw the legs on with 3" screws. Keep each leg parallel to the frame so its foot sits flat on the floor.

Make the yarn holder. It goes on the same side as the feeder, on your dominant-hand side. Mark the holder board 3" (7.5 cm) in from each end, centered on its width. With the ½" bit, drill a hole at each mark without going through, then push in the dowel rods.

Attach the feeder to the top back of the frame. Line the eye screws up with the dowels on the yarn holder below.

Secure the frame to the floor with weights or screws. One sandbag over each foot works well; about 20 lb (9 kg) each is enough. Hardware and garden stores sell them.

Test the Strength, and Add Wall Braces if Needed

Once it''s built, take two steps back and lean against the frame. It should hold your body weight without flexing much. If it bends or strains, add wall braces: two boards 14½" (36.8 cm) long (half the length of a foot plus the width of the frame), screwed to the top right and top left of the frame, sticking straight out the back so they rest against the wall. Now the feet support the bottom and the wall supports the top, so pressure on the frame goes into the wall instead of bending the frame. If you have thick baseboards or molding, make the braces an inch or so longer than the feet.

Tip: feed yarn from above. Whether your yarn holder is built into the frame or stands on its own, put feeder loops near the top of the frame. Yarn that feeds down from above flows to the machine more smoothly and doesn''t tangle, and the holder keeps cones from tipping over or rolling away.

Going Bigger

For frames longer than the freestanding frame, the beams need even more strength. Depending on your tools, there are three main options:

Doubled-up 2 × 6 lumber: Use doubled 2 × 6 boards for the longest lengths. If the frame is longer than standard board lengths, stagger the seams so the joints don''t line up.

Steel box tube: Very rigid, but needs welding or a metal shop. For reference, our 10 × 13 ft CNC frame is made from 4 × 6 box tube with a ¼" wall, which is more than most frames need.

Aluminum box tube (around 4 × 6): Much lighter and easier to work with than steel, and still stiff.

Professional tufting studios such as Kramis and Dovecot have shared videos of their frames, and those are worth a look for ideas. If you''d like help designing a specific frame, contact us. We offer frame design consultations for a small fee.

Replacing Damaged Tack Strips

If the tack strips on your frame get chipped or bent, you don''t need a new frame. Standard carpet tack strip is sold at home-improvement stores such as Home Depot. Pull off the damaged strips and attach new ones the same way, with glue and nails or staples, tacks pointing away from the center. Choose strip with pre-installed nails and avoid peel-and-stick versions.

Learn More in the Book

These projects come from Tuft the World: An Illustrated Manual to Tufting Gorgeous Rugs, Decor, and More, pages 36–47. The book has much more on setting up your tufting space, plus step-by-step projects. It''s available on our website and from all major booksellers.',
  description = 'Build a 30×30 tabletop or 72×66 freestanding tufting frame: materials lists, step-by-step photos and a frame size chart, from our book Tuft the World.',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE blog_handle = 'knowledge-base' AND shopify_handle = 'how-to-build-your-own-tufting-frame';
