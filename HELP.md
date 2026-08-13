# Pipe Fitter

Pipe Fitter is a tool that helps create transition connections from one tube-shaped object (like a PVC pipe or a
hose) to another. You can change the inner and outer diameter of each section, adjust the style of each end, and add
bends between the sections.

Each pipe is built as a chain of straight **sections** joined by **bends**: Section 1, Bend 1, Section 2, Bend 2,
Section 3, and so on. The simplest pipe is a single straight section with no bends at all. The first and last section
headers have a **+ Section** button that adds a new end section (the first prepends, the last appends, each copying the
section it was created from), and a **✕** button to remove an end section. A single section is both first and last, so
its **+ Section** appends. You can click on any section header to collapse it and make more room.

A design can hold up to four separate pipes joined end to end - see **Multiple Pipes** below.

## Straight Sections

Each section controls one straight run of the pipe. Start by specifying the inner and outer diameters. Then specify the
length. Use **Mimic Previous Section** / **Mimic Next Section** buttons to match a neighbor.


### End Treatment

Only the **first and last** sections have an **End Treatment** (the two open ends of the pipe). The first section
carries the **left end**, the last carries the **right end** - and a lone section carries both, one after the other in
its card, each labelled with its side. Two treatments on one section split its length between them, so each has half
the run to work in:

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
  thick as the wall, but that floor is inside the section and costs the joint nothing - set the joint length to 25
  and the pipes overlap by 25. A lead-in chamfer (on the spigot's outer tip, or the socket's bore mouth) makes it easier to
  slide the joint together. Increase the **tolerance** for a looser, easier slide; decrease it for a snugger fit.
  If the mating pipe is part of the same design, join it on with **+ Pipe** and the fit is worked out for you - see
  **Multiple Pipes**.

## Bends

Each bend joins two neighboring sections. Set its angle anywhere from -180° to 180° - the sign chooses which way it
turns, so two bends with alternating signs make an S-shape. An angle of 0° is a straight transition, and ±180° is a
full U-turn that doubles the pipe back on itself. The **Length** option measures the bend's length when it is
straight, but changes to measure the arc length along the outside of the inner bend once there is any angle. All
bends share one plane.

The limits to the minimum arc length depending on if the thicknesses and diameters of all the adjoining sections.
If all sections are equal in diameter and thickness, the arc length can be set below 1mm. As variations are 
introduced, the arc length may increase.

By default a bend blends the inner diameter and wall thickness **smoothly** from one neighboring section to the
other. Turn off **Continuous Ø** or **Continuous thickness** to instead set a fixed value at the middle of the
transition: make the diameter larger than both neighbors for a bulge or smaller for a pinch, and likewise thicken or
thin the wall. Each of these fixed controls includes buttons to quickly match the left neighbor, the right
neighbor, or the average of the two.

## Multiple Pipes

Sometimes one part isn't enough - a run is too long for the print bed, it has to come apart for cleaning, or two
halves need to bolt together. Use the **+ Pipe ↑** / **+ Pipe ↓** buttons on the first and last pipe headers to join a
new pipe onto the free end of the chain, up to four in all. The **✕** on a pipe header removes it; only the pipes at
either end of the chain can be removed. Clicking a header collapses the pipe's controls, to keep the panel manageable.

A new pipe starts as two sections copying the end it spawned from, with a straight transition between them. Its own
open end inherits that end's **treatment**, so the chain grows without losing the face it presents to the world - add
a pipe to a barbed end and the barb is on the new pipe's open end, ready for the same hose. It is a **separate part**:
it is meshed, oriented, and exported on its own. The 3D view and the cross section show the chain assembled so you can
see how the parts meet.

### The Joint

The two ends that meet are kept in agreement; changes to one end's diameter are reflected in the other. End treatments
must complement each other, so a mated end can be one of **Plain**, **Chamfer**, **Flange**, or **Slip Joint** - hose
barbs and teeth are not available at joints. Changing one side changes the other to suit: pick Flange and the mate 
becomes a flange, pick Slip Joint and the mate becomes a chamfer the stub to slide into. An end that had hose barbs
or teeth when a pipe was joined onto it is made plain, since there is nothing on the other side that can connect to
it.

Across every joint, the two mating sections **share their inner and outer diameter** - change either one and the
other follows. Their *lengths* stay independent. Beyond that:

- A **flange** joint shares its width, number of holes, and hole size, so the two flanges bolt together. Each part
  keeps its own **thickness**.
- A **slip joint** shares almost nothing. The joint length, the lead-in chamfer, and especially the **tolerance** belong
  to the side carrying the treatment - raising the tolerance opens up the fit without moving the mating pipe's diameters,
  which is exactly what you want when dialing in a slide. One limit does cross: the joint length can reach no further
  than the mating section's length, whichever side carries the treatment. An **Inside** (spigot) joint plugs into the
  mating pipe's bore, and an **Outside** (socket) joint swallows the mating pipe's end - either way the mate has only
  its own straight run to give before its bend gets in the way.
- A **chamfer** joint shares nothing: each end is chamfered however you like.

Shared values are labelled as such in the panel. Adding a section at a mated end is allowed - the new section takes
over the joint, inheriting the diameters and the end treatment, and the old one becomes an ordinary interior section.

## Download

You can download your pipe as either an STL or 3MF using the menus at the top. They can be oriented to stand on the
first or last end, to make 3D printing easier, or downloaded as-is.

With more than one pipe, an **STL** download is a ZIP holding one STL per pipe - an STL file can only carry one solid,
and each part is oriented on its own end face. A **3MF** download is a single file holding every pipe as its own
object: downloaded as-is they arrive arranged and oriented for printing, laid out side by side on the bed.

## Questions/Comments/Concerns?

The source code is available at <https://github.com/mankyd/pipefitter>

Reach out to Dave - mankyd@gmail.com

