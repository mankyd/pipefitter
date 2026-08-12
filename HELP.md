# Pipe Fitter

Pipe Fitter is a tool that helps create transition connections from one tube-shaped object (like a PVC pipe or a
hose) to another. You can change the inner and outer diameter of each section, adjust the style of each end, and add
bends between the sections.

Each pipe is built as a chain of straight **sections** joined by **bends**: Section 1, Bend 1, Section 2, Bend 2,
Section 3, and so on. The first and last section headers have a **+ Section** button that adds a new end section (the
first prepends, the last appends, each copying the section it was created from), and a **✕** button to remove an end
section. You can click on any section header to collapse it and make more room.

A design can hold up to four separate pipes joined end to end — see **Multiple Pipes** below.

## Straight Sections

Each section controls one straight run of the pipe. Start by specifying the inner and outer diameters. Then specify the
length. Use **Mimic Previous Section** / **Mimic Next Section** buttons to match a neighbor.


### End Treatment

Only the **first and last** sections have an **End Treatment** (the two open ends of the pipe):

- **Plain** is just a flat end.
- **Chamfer** lets you apply a taper to either the inside of the pipe, the outside of the pipe, or both. You can
  specify how far along the pipe the chamfer should travel (**X, along axis**), as well as how much of the thickness
  of the pipe the chamfer should consume (**Y, radial**). A chamfer with 0 for all of its values is the same as a
  Plain end.
- **Flange** adds a flat ring to the end of the pipe. You can specify how wide the ring is, how thick it is, and also
  add holes symmetrically around the center of the ring. The flange's thickness is included in the length of the
  section.
- **Hose Barb** adds a sharp saw-tooth shape to the end. You can control the height, spacing, and number of teeth to
  add.
- **Teeth** are like small sections  of hose barb, spaced out evenly around the opening. They can be rounded over
  smooth. They are useful for soft hoses lined with coiled wire, providing something for the hose to grab or screw
  onto without damaging it. Such hoses should still be clamped.
- **Slip Joint** makes a telescoping joint so two pipes slide together. Two opposing slip joints *do not* fit
  together. A slip joint is meant to connect with a plain or chamfered pipe on the other side. Choose **Inside** 
  for a spigot that plugs into the mating pipe (its outer Ø is set to this section's inner Ø minus the tolerance).
  Choose **Outside** for a socket the mate plugs into (its bore is set to this section's outer Ø plus the tolerance).
  The additional of a slip joint is *not* included in the length of the section. The length is measured to the 
  shoulder of the joint. **Joint length** is the engagement: how far the two pipes overlap once the joint is seated,
  which is the spigot's protruding stub or the depth of the socket's cup. Behind the shoulder sits a solid floor as
  thick as the wall, but that floor is inside the section and costs the joint nothing — set the joint length to 25
  and the pipes overlap by 25. A lead-in chamfer (on the spigot's outer tip, or the socket's bore mouth) makes it easier to
  slide the joint together. Increase the **tolerance** for a looser, easier slide; decrease it for a snugger fit.
  If the mating pipe is part of the same design, join it on with **+ Pipe** and the fit is worked out for you — see
  **Multiple Pipes**.

## Bends

Each bend joins two neighboring sections. Set its angle anywhere from −90° to 90° — the sign chooses which way it
turns, so two bends with alternating signs make an S-shape. An angle of 0° is a straight transition. The **Length**
option measures the bend's length when it is straight, but changes to measure the arc length along the outside of the
inner bend once there is any angle. All bends share one plane.

The limits to the minimum arc length depending on if the thicknesses and diameters of all the adjoining sections.
If all sections are equal in diameter and thickness, the arc length can be set below 1mm. As variations are 
introduced, the arc length may increase.

By default a bend blends the inner diameter and wall thickness **smoothly** from one neighboring section to the
other. Turn off **Continuous Ø** or **Continuous thickness** to instead set a fixed value at the middle of the
transition: make the diameter larger than both neighbors for a bulge or smaller for a pinch, and likewise thicken or
thin the wall. Each of these fixed controls includes buttons to quickly match the left neighbor, the right
neighbor, or the average of the two.

## Multiple Pipes

Sometimes one part isn't enough — a run is too long for the print bed, it has to come apart for cleaning, or two
halves need to bolt together. Use the **+ Pipe ↑** / **+ Pipe ↓** buttons on the first and last pipe headers to join a
new pipe onto the free end of the chain, up to four in all. The **✕** on a pipe header removes it; only the pipes at
the two ends of the chain can be removed. A pipe header also collapses the whole pipe, to keep the panel manageable.

A new pipe starts as two sections copying the end it grew from, with a straight transition between them. It is a
**separate part**: it is meshed, oriented, and exported on its own. The 3D view and the cross section show the chain
assembled — flange faces touching, slip joints slid home — so you can see how the parts meet.

### The Joint

The two ends that meet are one interface, so they are kept in agreement. Only end treatments that have an opposite
number can sit on a joint, so a mated end offers **Plain**, **Chamfer**, **Flange**, and **Slip Joint** only — hose
barbs and teeth are left off the menu. Changing one side changes the other to suit: pick Flange and the mate becomes a
flange, pick Slip Joint and the mate becomes a chamfered plain end for the stub to slide into.

Across every joint, the two mating sections **share their inner and outer diameter** — change either one and the
other follows. Their *lengths* stay independent. Beyond that:

- A **flange** joint shares its width, number of holes, and hole size, so the two flanges bolt together. Each part
  keeps its own **thickness**.
- A **slip joint** shares nothing else. The joint length, the lead-in chamfer, and especially the **tolerance** belong
  to the side carrying the stub — raising the tolerance opens up the fit without moving the mating pipe's diameters,
  which is exactly what you want when dialing in a slide. One limit does cross: an **Inside** (spigot) joint plugs
  into the mating pipe's bore, so it can reach no further than that mating section's length — past there the bore
  turns into the mate's bend and the stub would foul instead of seating. Shorten the mating section and the spigot
  follows it in. An **Outside** (socket) joint receives the mate rather than entering it, so nothing bounds it that
  way, and a pipe with no mate joined on keeps its joint length free.
- A **chamfer** joint shares nothing else: each end is chamfered however you like.

Shared values are labelled as such in the panel. Adding a section at a mated end is allowed — the new section takes
over the joint, inheriting the diameters and the end treatment, and the old one becomes an ordinary interior section.

## Download

You can download your pipe as either an STL or 3MF using the menus at the top. They can be oriented to stand on the
first or last end, to make 3D printing easier, or downloaded as-is.

With more than one pipe, an **STL** download is a ZIP holding one STL per pipe — an STL file can only carry one solid,
and each part is oriented on its own end face. A **3MF** download is a single file holding every pipe as its own
object: downloaded as-is they arrive assembled, and oriented for printing they are laid out side by side on the bed.

## Questions/Comments/Concerns?

The source code is available at <https://github.com/mankyd/pipefitter>

Reach out to Dave - mankyd@gmail.com

